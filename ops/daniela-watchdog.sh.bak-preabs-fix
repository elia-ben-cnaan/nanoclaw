#!/usr/bin/env bash
# daniela-watchdog v2: auto-recover Daniela agent (Netcup) from stuck-turn / dead-engine.
# Runs as root via cron.
# SAFETY (co-hosted box): Shellanoo AND Daniela both run as unix user 'daniela', so user
# alone CANNOT tell them apart. Kills are scoped by walking the process tree from Daniela's
# OWN agent containers (docker label nanoclaw-install=4dbe7aa6). Shellanoo containers
# (install 454ebe7e, /root/nanoclaw-v2) are never enumerated -> never touched.
# DRY_RUN=1 -> report only, no kill/restart.
set -u

BASE=/home/daniela/nanoclaw-v2
LOG="$BASE/logs/watchdog.log"
DUID="$(id -u daniela)"
RUN="env XDG_RUNTIME_DIR=/run/user/$DUID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$DUID/bus"
DAN_INSTALL=4dbe7aa6
STUCK_HANG=1800     # 30 min AND process state D/Z (uninterruptible/zombie) = genuinely hung
STUCK_ABS=14400     # 4 h absolute catch-all regardless of state (no legit turn runs this long)
DRY="${DRY_RUN:-0}"

ts(){ date -u +%FT%TZ; }
log(){ echo "$(ts) $*" >> "$LOG"; }

# recursive descendants of a pid (host process tree)
descendants(){ local p="$1" k; for k in $(ps -o pid= --ppid "$p" 2>/dev/null); do echo "$k"; descendants "$k"; done; }

acted=0

# 1) stuck claude turns, scoped to Daniela's own containers only
for c in $(docker ps -q --filter "label=nanoclaw-install=$DAN_INSTALL" 2>/dev/null); do
  cpid="$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null)"
  [ -z "${cpid:-}" ] || [ "$cpid" = "0" ] && continue
  for p in $(descendants "$cpid"); do
    args="$(ps -o args= -p "$p" 2>/dev/null)"
    case "$args" in *claude.exe*) ;; *) continue;; esac
    secs="$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')"
    stat="$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ')"
    case "$secs" in ''|*[!0-9]*) continue;; esac
    hung=0
    if [ "$secs" -gt "$STUCK_ABS" ]; then hung=1; fi
    if [ "$secs" -gt "$STUCK_HANG" ]; then case "$stat" in D*|Z*) hung=1;; esac; fi
    if [ "$hung" = 1 ]; then
      log "STUCK daniela claude pid=$p age=${secs}s stat=$stat container=$c DRY=$DRY -> kill tree"
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

# 2) engine must be active (safe: never kills turns)
if ! sudo -u daniela $RUN systemctl --user is-active --quiet daniela.service; then
  log "daniela.service NOT active DRY=$DRY -> restart"
  if [ "$DRY" != 1 ]; then sudo -u daniela $RUN systemctl --user restart daniela.service; acted=1; fi
fi

# 3) prune only EXITED daniela containers (never running, never root install)
if [ "$DRY" != 1 ] && [ "$acted" = 1 ]; then
  for c in $(docker ps -a -q --filter "status=exited" --filter "label=nanoclaw-install=$DAN_INSTALL" 2>/dev/null); do
    docker rm "$c" >/dev/null 2>&1 && log "pruned exited daniela container $c"
  done
fi

exit 0
