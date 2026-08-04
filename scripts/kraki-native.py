#!/usr/bin/env python3
"""CLI client for Kraki's Debug-only native automation socket.

This client never launches, activates, or restarts Kraki. It only connects to
an already-running automation-enabled Debug build.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import uuid

DEFAULT_SOCKET = f"/tmp/kraki-native-automation-{os.getuid()}.sock"


def request(method: str, params: dict, socket_path: str) -> dict:
    payload = {
        "id": str(uuid.uuid4()),
        "method": method,
        "params": params,
    }
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(max(10.0, params.get("timeoutMs", 0) / 1000 + 5.0))
        client.connect(socket_path)
    except OSError as error:
        raise SystemExit(
            f"Kraki native automation is unavailable at {socket_path}: {error}. "
            "This client will not launch or activate the app."
        )
    with client:
        client.sendall(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        response = bytearray()
        while b"\n" not in response:
            chunk = client.recv(65536)
            if not chunk:
                break
            response.extend(chunk)
    if not response:
        raise SystemExit("Kraki closed the automation connection without a response")
    result = json.loads(response.split(b"\n", 1)[0])
    if not result.get("ok"):
        error = result.get("error", {})
        raise SystemExit(f"{error.get('code', 'error')}: {error.get('message', 'Unknown error')}")
    return result["result"]


def compact(values: dict) -> dict:
    return {key: value for key, value in values.items() if value is not None}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--socket", default=os.environ.get("KRAKI_NATIVE_AUTOMATION_SOCKET", DEFAULT_SOCKET))
    sub = root.add_subparsers(dest="command", required=True)

    sub.add_parser("ping")
    sub.add_parser("snapshot")

    create = sub.add_parser("create-session")
    create.add_argument("--device", required=True)
    create.add_argument("--agent", required=True)
    create.add_argument("--model", required=True)
    create.add_argument("--effort", choices=["low", "medium", "high", "xhigh"])
    create.add_argument("--prompt")
    create.add_argument("--cwd")
    create.add_argument("--title")

    select = sub.add_parser("select-session")
    select.add_argument("session_id")

    send = sub.add_parser("send-input")
    send.add_argument("session_id")
    send.add_argument("text")
    send.add_argument("--delivery", choices=["prompt", "steer"], default="prompt")

    mode = sub.add_parser("set-mode")
    mode.add_argument("session_id")
    mode.add_argument("mode", choices=["safe", "discuss", "execute", "delegate"])

    abort = sub.add_parser("abort")
    abort.add_argument("session_id")

    steps = sub.add_parser("present-steps")
    steps.add_argument("session_id")
    steps.add_argument("--seq", type=int)

    request_steps = sub.add_parser("request-steps")
    request_steps.add_argument("session_id")
    request_steps.add_argument("seq", type=int)

    sub.add_parser("close-steps")

    permission = sub.add_parser("permission")
    permission.add_argument("session_id")
    permission.add_argument("decision", choices=["approve", "execute", "always_allow", "deny"])

    answer = sub.add_parser("answer")
    answer.add_argument("session_id")
    answer.add_argument("text")
    answer.add_argument("--choice", action="store_true", help="answer came from a fixed choice, not freeform")

    capture = sub.add_parser("capture")
    capture.add_argument("path")
    capture.add_argument("--sheet", action="store_true")

    wait = sub.add_parser("wait")
    wait.add_argument(
        "condition",
        choices=["connected", "sessionCreated", "sessionIdle", "messageContains", "stepsLoaded", "stepsPresented", "selectedSession"],
    )
    wait.add_argument("--timeout", type=int, default=30_000, help="milliseconds")
    wait.add_argument("--request-id")
    wait.add_argument("--session-id")
    wait.add_argument("--seq", type=int)
    wait.add_argument("--text")

    sub.add_parser("shutdown")
    return root


def main() -> None:
    args = parser().parse_args()
    command = args.command
    if command == "ping":
        method, params = "ping", {}
    elif command == "snapshot":
        method, params = "snapshot", {}
    elif command == "create-session":
        method = "createSession"
        params = compact({
            "targetDeviceId": args.device,
            "agentId": args.agent,
            "model": args.model,
            "reasoningEffort": args.effort,
            "prompt": args.prompt,
            "cwd": args.cwd,
            "title": args.title,
        })
    elif command == "select-session":
        method, params = "selectSession", {"sessionId": args.session_id}
    elif command == "send-input":
        method, params = "sendInput", {"sessionId": args.session_id, "text": args.text, "delivery": args.delivery}
    elif command == "set-mode":
        method, params = "setMode", {"sessionId": args.session_id, "mode": args.mode}
    elif command == "abort":
        method, params = "abort", {"sessionId": args.session_id}
    elif command == "present-steps":
        method, params = "presentSteps", compact({"sessionId": args.session_id, "seq": args.seq})
    elif command == "request-steps":
        method, params = "requestSteps", {"sessionId": args.session_id, "seq": args.seq}
    elif command == "close-steps":
        method, params = "closeSteps", {}
    elif command == "permission":
        method, params = "permission", {"sessionId": args.session_id, "decision": args.decision}
    elif command == "answer":
        method, params = "answer", {"sessionId": args.session_id, "text": args.text, "wasFreeform": not args.choice}
    elif command == "capture":
        method, params = "capture", {"path": args.path, "sheetOnly": args.sheet}
    elif command == "wait":
        method = "wait"
        params = compact({
            "condition": args.condition,
            "timeoutMs": args.timeout,
            "requestId": args.request_id,
            "sessionId": args.session_id,
            "seq": args.seq,
            "text": args.text,
        })
    elif command == "shutdown":
        method, params = "shutdown", {}
    else:
        raise AssertionError(command)

    print(json.dumps(request(method, params, args.socket), indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
