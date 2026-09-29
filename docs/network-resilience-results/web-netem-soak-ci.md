# Web: W0–W6, netem N1–N5 and a 5-minute soak (final CI run 36515348385)

ubuntu-latest, runner Chrome. tc netem on loopback, per link (port-filtered), MTU 1500, offloads off. Soak seed = CI run number.
Before the fixes in this PR, soak seeds 1300, 2001 and 2003 failed (false "Not delivered"; seed 2003 lost 9 inputs); see test plan §13.1.

| Scenario | metrics |
|---|---|
| N1 | `{"settleMs": 10, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 203, "confirmP95Ms": 374, "confirmMaxMs": 374, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| N2 | `{"settleMs": 11, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 331, "confirmP95Ms": 2341, "confirmMaxMs": 2341, "lost": [], "duplicated": [], "stillSending": 0}` |
| N3 | `{"settleMs": 22, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 659, "confirmP95Ms": 932, "confirmMaxMs": 932, "lost": [], "duplicated": [], "stillSending": 0, "reconnectsApp": 0, "reconnectsTentacle": 0}` |
| N4 | `{"settleMs": 15, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 2000, "confirmP95Ms": 2692, "confirmMaxMs": 2692, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| N5 | `{"settleMs": 531, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 15185, "confirmP95Ms": 35640, "confirmMaxMs": 35640, "lost": [], "duplicated": [], "stillSending": 0}` |
| S1 | `{"seed": 1309, "minutes": 5, "actions": {"netem": 5, "send": 62, "reset": 6, "burst": 1, "heal": 7, "reload": 1, "blackhole": 2, "outage": 1}, "heapStartMb": 7.8, "t0": 1790651300835, "failedBeforeReload": {}, "settleMs": 15, "failedEver": false, "reconnectingEver": true, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 409, "confirmP95Ms": 17157, "confirmMaxMs": 18993, "lost": [], "duplicated": [], "stillSending": 0, "messages": 62, "heapEndMb": 11.4}` |
| W0 | `{"settleMs": 58, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 126, "confirmP95Ms": 176, "confirmMaxMs": 176, "lost": [], "duplicated": [], "stillSending": 0}` |
| W1 | `{"settleMs": 825, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 720, "confirmP95Ms": 720, "confirmMaxMs": 720, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 1}` |
| W2 | `{"settleMs": 1859, "failedEver": false, "reconnectingEver": true, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 56355, "confirmP95Ms": 56355, "confirmMaxMs": 56355, "lost": [], "duplicated": [], "stillSending": 0}` |
| W3 | `{"deadLinkDetectMs": 23574, "settleMs": 1367, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 24937, "confirmP95Ms": 24937, "confirmMaxMs": 24937, "lost": [], "duplicated": [], "stillSending": 0}` |
| W4 | `{"settleMs": 87071, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": 87032, "confirmP95Ms": 87032, "confirmMaxMs": 87032, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| W5 | `{"settleMs": 66, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": null, "confirmP95Ms": null, "confirmMaxMs": null, "lost": [], "duplicated": [], "stillSending": 0}` |
| W6 | `{"settleMs": 27, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "failedAt": {}, "confirmP50Ms": null, "confirmP95Ms": null, "confirmMaxMs": null, "lost": [], "duplicated": [], "stillSending": 0}` |
