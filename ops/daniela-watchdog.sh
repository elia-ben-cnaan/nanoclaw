#!/usr/bin/env bash
# daniela-watchdog v3: auto-recover Daniela agent (Netcup) from stuck-turn / dead-engine.
# Runs as root via cron.
# SAFETY (co-hosted box): Shellanoo AND Daniela both run as unix user 'daniela', so user
# alone CANNOT tell them apart. Kills are scoped by walking the process tree from Daniela's
# OWN agent containers (docker label nanoclaw-install=4dbe7aa6). Shellanoo containers
# (install 454ebe7e, /root/nanoclaw-v2) are never enumerated -> never touched.
# DRY_RUN=1 -> report only, no kill/restart.
#
# v3 (2026-09-19): claude.exe runs in --input-format stream-json = ONE long-lived process
# per session, NOT one per turn. So raw age is a false stuck-signal: a healthy session that
# keeps chatting for 4h+ was being SIGKILLed by the old unconditional STUCK_ABS. Fix: the
# absolute-age catch-all now ALSO requires the session turn to be frozen (sessions.last_active
# older than STUCK_FREEZE) before killing. The D/Z 30-min hang path is unchanged (real hangs
# show as uninterruptible/zombie regardless of age). Backup: daniela-watchdog.sh.bak-preabs-fix
set -u

BASE=/home/daniela/nanoclaw-v2
LOG="$BASE/logs/watchdog.log"
DB="$BASE/data/v2.db"
DUID="$(id -u daniela)"
RUN="env XDG_RUNTIME_DIR=/run/user/$DUID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$DUID/bus"
DAN_INSTALL=4dbe7aa6
STUCK_HANG=1800     # 30 min AND process state D/Z (uninterruptible/zombie) = genuinely hung
STUCK_ABS=14400     # 4 h absolute, but only if the turn is also frozen (see STUCK_FREEZE)
STUCK_FREEZE=900    # 15 min: sessions.last_active older than this = turn not progressing
DRY="${DRY_RUN:-0}"

ts(){ date -u +%FT%TZ; }
log(){ echo "$(ts) $*" >> "$LOG"; }

descendants(){ local p="$1" k; for k in $(ps -o pid= --ppid "$p" 2>/dev/null); do echo "$k"; descendants "$k"; done; }

# seconds since a session's last_active (echoes big number if unknown/unparseable)
idle_secs(){
  local c="$1" sess la la_epoch now
  sess="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$c" 2>/dev/null | xargs -r basename)"
  [ -z "$sess" ] && { echo 999999; return; }
  la="$(sqlite3 "$DB" "select last_active from sessions where id='$sess';" 2>/dev/null)"
  [ -z "$la" ] && { echo 999999; return; }
  la_epoch="$(date -u -d "$la" +%s 2>/dev/null)"
  [ -z "$la_epoch" ] && { echo 999999; return; }
  now="$(date -u +%s)"
  echo $(( now - la_epoch ))
}

acted=0

for c in $(docker ps -q --filter "label=nanoclaw-install=$DAN_INSTALL" 2>/dev/null); do
  cpid="$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null)"
  [ -z "${cpid:-}" ] || [ "$cpid" = "0" ] && continue
  for p in $(descendants "$cpid"); do
    args="$(ps -o args= -p "$p" 2>/dev/null)"
    case "$args" in *claude.exe*) ;; *) continue;; esac
    secs="$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')"
    stat="$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ')"
    case "$secs" in ''|*[!0-9]*) continue;; esac
    hung=0; why=""
    # genuine hang: uninterruptible/zombie for >30min, any age
    if [ "$secs" -gt "$STUCK_HANG" ]; then case "$stat" in D*|Z*) hung=1; why="dz";; esac; fi
    # absolute-age catch-all: only if the turn is also frozen (guards healthy long sessions)
    if [ "$hung" = 0 ] && [ "$secs" -gt "$STUCK_ABS" ]; then
      idle="$(idle_secs "$c")"
      if [ "$idle" -gt "$STUCK_FREEZE" ]; then hung=1; why="abs+frozen(idle=${idle}s)";
      else log "SKIP daniela claude pid=$p age=${secs}s stat=$stat idle=${idle}s container=$c -> healthy long session, not killed"; fi
    fi
    if [ "$hung" = 1 ]; then
      log "STUCK daniela claude pid=$p age=${secs}s stat=$stat why=$why container=$c DRY=$DRY -> kill tree"
      if [ "$DRY" != 1 ]; then
        ppid="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
        pkill -9 -P "$p" 2>/dev/null
        kill -9 "$p" 2>/dev/null
        [ -n "${ppid:-}" ] && [ "$ppid" != 1 ] && kill -9 "$ppid" 2>/dev/null
        acted=1
      fi
    fi
  done
done

if ! sudo -u daniela $RUN systemctl --user is-active --quiet daniela.service; then
  log "daniela.service NOT active DRY=$DRY -> restart"
  if [ "$DRY" != 1 ]; then sudo -u daniela $RUN systemctl --user restart daniela.service; acted=1; fi
fi

if [ "$DRY" != 1 ] && [ "$acted" = 1 ]; then
  for c in $(docker ps -a -q --filter "status=exited" --filter "label=nanoclaw-install=$DAN_INSTALL" 2>/dev/null); do
    docker rm "$c" >/dev/null 2>&1 && log "pruned exited daniela container $c"
  done
fi

exit 0
