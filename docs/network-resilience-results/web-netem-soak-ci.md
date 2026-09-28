# Web: netem matrix + 5-minute soak (CI run, ubuntu-latest, runner Chrome)

tc netem on loopback, per-link (port-filtered), MTU 1500, offloads off. Soak seed = CI run number.

| Scenario | metrics |
|---|---|
| N1 | `{"settleMs": 11, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 236, "confirmP95Ms": 353, "confirmMaxMs": 353, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| N2 | `{"settleMs": 2858, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 401, "confirmP95Ms": 16667, "confirmMaxMs": 16667, "lost": [], "duplicated": [], "stillSending": 0}` |
| N3 | `{"settleMs": 15, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 21859, "confirmP95Ms": 30121, "confirmMaxMs": 30121, "lost": [], "duplicated": [], "stillSending": 0, "reconnectsApp": 0, "reconnectsTentacle": 0}` |
| N4 | `{"settleMs": 10, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 847, "confirmP95Ms": 1753, "confirmMaxMs": 1753, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| S1 | `{"seed": 1299, "minutes": 5, "actions": {"outage": 2, "send": 69, "burst": 34, "heal": 6, "reset": 7, "slow": 1, "blackhole": 2, "reload": 2, "netem": 2}, "heapStartMb": 10.1, "settleMs": 1052, "failedEver": false, "reconnectingEver": true, "blockedEver": false, "confirmP50Ms": 4854, "confirmP95Ms": 33340, "confirmMaxMs": 33340, "lost": [], "duplicated": [], "stillSending": 0, "messages": 69, "heapEndMb": 14.5, "stats": {"app": {"live": 1, "total": 21, "bytes": {"up": 387327, "down": 27685256}}, "app2": {"live": 0, "total": 0}, "tentacle": {"live": 1, "total": 2}}}` |
| W0 | `{"settleMs": 51, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 134, "confirmP95Ms": 198, "confirmMaxMs": 198, "lost": [], "duplicated": [], "stillSending": 0}` |
| W1 | `{"settleMs": 787, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 729, "confirmP95Ms": 729, "confirmMaxMs": 729, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 1}` |
| W2 | `{"settleMs": 3902, "failedEver": false, "reconnectingEver": true, "blockedEver": false, "confirmP50Ms": 58546, "confirmP95Ms": 58546, "confirmMaxMs": 58546, "lost": [], "duplicated": [], "stillSending": 0}` |
| W3 | `{"deadLinkDetectMs": 23586, "settleMs": 1309, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 24922, "confirmP95Ms": 24922, "confirmMaxMs": 24922, "lost": [], "duplicated": [], "stillSending": 0}` |
| W4 | `{"settleMs": 87146, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": 87092, "confirmP95Ms": 87092, "confirmMaxMs": 87092, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| W5 | `{"settleMs": 3950, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "confirmP50Ms": null, "confirmP95Ms": null, "confirmMaxMs": null, "lost": [], "duplicated": [], "stillSending": 0}` |
