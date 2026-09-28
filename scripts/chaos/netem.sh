#!/bin/bash
# Packet-level impairment of one chaos-stack link on Linux loopback (tc netem).
# CI only (needs root). Never run on a developer machine or a server.
#
#   netem.sh setup                    prio root qdisc, MTU 1500, no offloads
#   netem.sh set <band> <port> [netem args…]
#                                     impair traffic to/from <port> (both
#                                     directions) via band <band> (4..6);
#                                     no args = pass-through
#   netem.sh teardown                 remove everything, restore lo
#   netem.sh show
#
# Example: netem.sh set 4 41234 delay 80ms 40ms distribution normal loss 3% reorder 5%
set -euo pipefail
DEV=lo
[ "$(uname -s)" = Linux ] || { echo "netem.sh: Linux only" >&2; exit 2; }

case "${1:-}" in
  setup)
    modprobe sch_netem 2>/dev/null || true
    tc qdisc del dev "$DEV" root 2>/dev/null || true
    # Real-network packet sizes: with a 64 KiB loopback MTU and offloads, one
    # "packet" would carry a whole WebSocket frame and loss would be unrealistic.
    ip link set dev "$DEV" mtu 1500
    ethtool -K "$DEV" tso off gso off gro off 2>/dev/null || true
    # Bands 0-2 keep the default priomap (unimpaired); 3-5 are per-link.
    tc qdisc add dev "$DEV" root handle 1: prio bands 6 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
    for band in 4 5 6; do
      tc qdisc add dev "$DEV" parent "1:$band" handle "${band}0:" netem delay 0ms
    done
    ;;
  set)
    band="$2"; port="$3"; shift 3
    case "$band" in 4|5|6) ;; *) echo "band must be 4..6" >&2; exit 2 ;; esac
    if ! tc filter show dev "$DEV" parent 1: | grep -q "flowid 1:$band"; then
      tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 match ip dport "$port" 0xffff flowid "1:$band"
      tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 match ip sport "$port" 0xffff flowid "1:$band"
    fi
    if [ $# -eq 0 ]; then set -- delay 0ms; fi
    tc qdisc change dev "$DEV" parent "1:$band" handle "${band}0:" netem "$@"
    ;;
  teardown)
    tc qdisc del dev "$DEV" root 2>/dev/null || true
    ip link set dev "$DEV" mtu 65536 || true
    ;;
  show)
    tc -s qdisc show dev "$DEV"
    tc filter show dev "$DEV" parent 1: || true
    ;;
  *)
    sed -n '2,14p' "$0"; exit 2 ;;
esac
