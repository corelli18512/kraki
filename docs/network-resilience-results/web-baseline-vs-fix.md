# Web network resilience — baseline (main 4e6ca01) vs fix

Local chaos stack (Head + real Tentacle + fault proxy), built web app in headless Chromium.

| Scenario | main | fix |
|---|---|---|
| W0 healthy | `{"settleMs": 7, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` | `{"settleMs": 14, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` |
| W1 flash reset | `{"settleMs": 1550, "failedEver": false, "reconnectingEver": true, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 1}` | `{"settleMs": 773, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 1}` |
| W2 60 s outage | timed out: after 5 retries (~31 s) a blocking "Disconnected — Connect now" modal covered the app | `{"settleMs": 3370, "failedEver": false, "reconnectingEver": true, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` |
| W3 half-open | `{"deadLinkDetectMs": 35132, "settleMs": 2091, "failedEver": true, "reconnectingEver": true, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` | `{"deadLinkDetectMs": 23749, "settleMs": 1296, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` |
| W4 1 MB message @ 0.32 Mbit/s | `{"settleMs": 20077, "failedEver": true, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` | `{"settleMs": 86928, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0, "reconnects": 0}` |
| W5 reload with unconfirmed input | `{"settleMs": 30142, "failedEver": true, "reconnectingEver": false, "blockedEver": false, "lost": ["w5-fj582f"], "duplicated": [], "stillSending": 0}` | `{"settleMs": 4145, "failedEver": false, "reconnectingEver": false, "blockedEver": false, "lost": [], "duplicated": [], "stillSending": 0}` |
