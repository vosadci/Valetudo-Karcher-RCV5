#!/usr/bin/env python3
#
# Speaks the Kärcher Home app's SoftAP WiFi-provisioning protocol directly —
# reconfigures a robot's WiFi with no app, no ADB, no disassembly. Only
# requirement: WiFi range of the robot's own onboarding hotspot (open, no
# password — join it from your Mac's WiFi settings before running this).
#
# Trigger onboarding mode by holding the robot's two top buttons for 5+
# seconds ("network and wifi configuration mode"). The alternative,
# configure-wifi.sh, needs a rooted robot reachable over adb; this script
# needs neither root nor adb, only radio range — the two are complementary,
# not redundant. See README.md "Recovering from a WiFi/config reset" for
# when to reach for which.
#
# Protocol confirmed 2026-09-25 by strace-capturing a real pairing session
# directly on the robot (recv() buffer contents at the syscall boundary) —
# every byte below is from a real capture, not decompiled-source guesswork.
# Live-confirmed end to end against real hardware the same day. Full
# writeup, including a wire-format detail the decompiled Kotlin source gets
# wrong (implies BLE-style chunking the real WiFi path never uses), lives in
# this project's own research notes — ask if you need the deep trace.
#
#   - Robot listens on plain TCP 192.168.5.1:6008.
#   - Every message, both directions, is a 20-byte little-endian header:
#         magic     4 bytes = 58 91 58 51 (constant)
#         reserved1 4 bytes (0 when client-originated)
#         msg_type  4 bytes (101=WRITE_DATA_FROM_DEVICE request,
#                             102=RECEIEVE_DATA_FROM_DEVICE reply,
#                             105=STOP_CONNECT)
#         length    4 bytes = length of the payload that follows
#         reserved2 4 bytes (0 when client-originated)
#     ...followed by exactly `length` bytes of payload: a JSON object,
#     AES-128-ECB/PKCS7 encrypted, then base64-encoded, sent as ONE block.
#   - AES key = MD5(tenantId)[8:24], tenantId="1528983614213726208" is a
#     hardcoded APK constant -> key bytes are the ASCII string
#     "0310abafaa3a2268". Verified byte-for-byte against a real capture.
#   - Request JSON fields: ssid, pwd, http_host, mqtt_host, mqtt_port, key,
#     uid, district (http_port is deliberately never sent — it's a nullable
#     field in the app's own data class that Gson drops when unset). The
#     robot only checks these fields are PRESENT, never validates their
#     content — confirmed via disassembly — so only ssid/pwd are prompted
#     for; the rest default automatically (see gather_wifi_data()).
#   - Reply JSON: {"sn":..., "mac":..., "productId":..., "cmdId":...}.
#
# ACCOUNT-LINKAGE SAFETY NOTE: `uid` is the Kärcher cloud ACCOUNT that ends
# up owning the robot, not a robot identifier — and this toolkit supports
# switching a robot back to real cloud mode later (karcher-cloud-switch.sh
# cloud). Because of that, `uid`/`key` default to freshly-generated
# placeholders that can never be mistaken for a real account, rather than
# any real captured value — see generate_placeholder_uid()'s comment for the
# full reasoning. Pass RCV5_UID explicitly if you want to preserve a
# specific robot's real prior account link.
#
# CRITICAL TIMING NOTE, load-bearing for actually using this successfully:
# the robot's AP-mode listening socket has a hardcoded ~7-second lifetime —
# it opens roughly 2 seconds after the two-button trigger and closes itself
# permanently about 7 seconds later, whether or not anything connected. This
# is a ONE-SHOT window, not a recurring one. That's why every prompt below
# happens before you're told to press the buttons: get everything answered
# first, so the connection attempts (which retry automatically) start
# racing the window immediately once you trigger it, instead of losing the
# window to typing.
#
# Usage: python3 provision-wifi.py
# Needs the `cryptography` package (already a prerequisite of this
# directory, for gen_cert.py): pip install cryptography
#
# Never pass credentials as argv -- prompts at runtime instead (or reads
# RCV5_* env vars, see below), matching every other tool in this toolkit.

from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import struct
import sys
import time
from getpass import getpass

try:
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:
    sys.exit(
        "ERROR: this script needs the 'cryptography' package.\n"
        "Install it with: pip install cryptography\n"
        "(already a prerequisite of this directory, for gen_cert.py)"
    )

# Same bold/color convention as lib.sh's ok()/warn() (Magenta, not yellow --
# too easily confused with green in some terminal color schemes). Falls back
# to plain text when stdout isn't a terminal.
if sys.stdout.isatty():
    BOLD = "\033[1m"
    MAGENTA = "\033[1;35m"
    RESET = "\033[0m"
else:
    BOLD = MAGENTA = RESET = ""


def warn(*args) -> None:
    print(f"{BOLD}{MAGENTA}{' '.join(str(a) for a in args)}{RESET}")


HOST = "192.168.5.1"
PORT = 6008
AES_KEY = b"0310abafaa3a2268"  # MD5(tenantId)[8:24], see the protocol notes above
MAGIC = bytes.fromhex("58915851")

WRITE_DATA_FROM_DEVICE = 101
RECEIEVE_DATA_FROM_DEVICE = 102
STOP_CONNECT = 105

HEADER_FMT = "<4sIIII"  # magic, reserved1, msg_type, length, reserved2
HEADER_LEN = struct.calcsize(HEADER_FMT)
assert HEADER_LEN == 20

CONNECT_RETRY_SECONDS = 25
CONNECT_RETRY_INTERVAL = 0.5


def aes_ecb_encrypt(plaintext: bytes) -> bytes:
    padder = padding.PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(AES_KEY), modes.ECB()).encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def aes_ecb_decrypt(ciphertext: bytes) -> bytes:
    decryptor = Cipher(algorithms.AES(AES_KEY), modes.ECB()).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
    return unpadder.update(padded) + unpadder.finalize()


def build_header(msg_type: int, length: int) -> bytes:
    return struct.pack(HEADER_FMT, MAGIC, 0, msg_type, length, 0)


def build_wifi_data_bean(ssid, pwd, http_host, mqtt_host, mqtt_port, key, uid, district) -> dict:
    # Field order/set matches a real captured request exactly -- http_port
    # deliberately omitted, the real app never sends it.
    return {
        "mqtt_host": mqtt_host,
        "uid": uid,
        "pwd": pwd,
        "http_host": http_host,
        "mqtt_port": mqtt_port,
        "key": key,
        "ssid": ssid,
        "district": district,
    }


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError(f"connection closed after {len(buf)}/{n} bytes")
        buf += chunk
    return buf


def recv_message(sock: socket.socket):
    header = recv_exact(sock, HEADER_LEN)
    magic, _reserved1, msg_type, length, _reserved2 = struct.unpack(HEADER_FMT, header)
    if magic != MAGIC:
        raise ValueError(f"bad magic in reply header: {magic.hex()} (expected {MAGIC.hex()})")
    payload = recv_exact(sock, length) if length else b""
    return msg_type, payload


def prompt(env_var: str, label: str, *, secret: bool = False) -> str:
    env_val = os.environ.get(env_var, "").strip()
    if env_val:
        return env_val
    ask = getpass if secret else input
    value = ask(f"{label}: ")
    return value if secret else value.strip()


def generate_placeholder_uid() -> str:
    # Real Kärcher account uids are 19-digit all-numeric Snowflake-style IDs
    # (e.g. "1977658551081373696", captured from a real pairing). This is
    # deliberately NOT in that shape -- a prefixed hex string -- so it can
    # never collide with, or be mistaken for, a real account id. Matters
    # because this toolkit supports switching a robot back to real cloud
    # mode later (karcher-cloud-switch.sh cloud) -- uid is which cloud
    # ACCOUNT owns the robot, so hardcoding a real one as a script default
    # would silently tie every robot provisioned this way to that account.
    return f"unlinked-{secrets.token_hex(10)}"


def generate_placeholder_key() -> str:
    # Same reasoning as generate_placeholder_uid(): never reuse a real
    # captured pairing-session token as a script default, even though this
    # field isn't personally identifying the way uid is -- defense in depth
    # for the same account-binding handshake.
    return secrets.token_hex(8)


def gather_wifi_data() -> dict:
    print("Home WiFi being configured on the robot:")
    ssid = prompt("RCV5_SSID", "  SSID")
    if not ssid:
        sys.exit("ERROR: SSID cannot be empty")
    pwd = prompt("RCV5_PWD", "  Password (not echoed)", secret=True)
    if not pwd:
        sys.exit("ERROR: password cannot be empty")

    # Cloud-pairing fields: the robot only checks these are PRESENT, never
    # validates their content (confirmed via disassembly) -- so these
    # default automatically instead of prompting, keeping the interactive
    # flow to just SSID/password (every extra prompt eats into the ~7s
    # pairing window once the buttons get pressed).
    #
    # uid/key default to freshly-generated placeholders, NEVER a real
    # captured value -- see generate_placeholder_uid() for why that
    # specifically matters. If this robot was already paired via the app
    # and you want to preserve that account link for later (e.g. switching
    # back to cloud mode), read its real uid from
    # /userdata/config/wifi.conf over ssh BEFORE triggering the reset (the
    # reset wipes it from the robot itself), then pass it as RCV5_UID.
    uid = os.environ.get("RCV5_UID", "").strip() or generate_placeholder_uid()
    key = os.environ.get("RCV5_KEY", "").strip() or generate_placeholder_key()
    http_host = os.environ.get("RCV5_HTTP_HOST", "").strip() or "eu-cdndevaiot.3irobotix.net"
    mqtt_host = os.environ.get("RCV5_MQTT_HOST", "").strip() or "eu-gamqttaiot.3irobotix.net"
    mqtt_port_str = os.environ.get("RCV5_MQTT_PORT", "").strip() or "8883"
    # DEU (Germany, ISO 3166-1 alpha-3) rather than any region tied to a real
    # captured session -- Kärcher is a German company, a neutral choice that
    # doesn't leak anything about who actually ran this script.
    district = os.environ.get("RCV5_DISTRICT", "").strip() or "DEU"
    try:
        mqtt_port = int(mqtt_port_str)
    except ValueError:
        sys.exit(f"ERROR: RCV5_MQTT_PORT must be a number, got {mqtt_port_str!r}")

    print()
    print("Cloud-pairing fields (not prompted -- override with RCV5_UID / RCV5_KEY / "
          "RCV5_HTTP_HOST / RCV5_MQTT_HOST / RCV5_MQTT_PORT / RCV5_DISTRICT env vars):")
    print(f"  uid={uid}")
    print(f"  key={key}")
    print(f"  http_host={http_host}  mqtt_host={mqtt_host}:{mqtt_port}  district={district}")

    return build_wifi_data_bean(
        ssid=ssid, pwd=pwd, http_host=http_host, mqtt_host=mqtt_host,
        mqtt_port=mqtt_port, key=key, uid=uid, district=district,
    )


def connect_with_retry() -> tuple[socket.socket, int]:
    deadline = time.monotonic() + CONNECT_RETRY_SECONDS
    attempt = 0
    last_err = None
    while time.monotonic() < deadline:
        attempt += 1
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        try:
            sock.connect((HOST, PORT))
            sock.settimeout(10)
            return sock, attempt
        except OSError as e:
            last_err = e
            sock.close()
            print(f"  attempt {attempt}: {e} -- retrying")
            time.sleep(CONNECT_RETRY_INTERVAL)
    sys.exit(
        f"ERROR: could not connect to {HOST}:{PORT} after {attempt} attempts over "
        f"{CONNECT_RETRY_SECONDS}s -- {last_err}\n"
        f"\n"
        f"Most likely cause: the robot's pairing window (about 7 seconds, starting\n"
        f"~2s after the two-button trigger) had already closed before this script\n"
        f"got its first attempt in. This is a one-shot window, not recurring --\n"
        f"retrying longer won't help once it's closed. Try again: re-run this script\n"
        f"from the start, and press the two buttons within a second or two of hitting\n"
        f"enter at the '== Ready ==' prompt below, not before it.\n"
        f"\n"
        f"If it still never connects: confirm you're actually joined to the robot's\n"
        f"onboarding AP (not your home WiFi), and that nothing else (an open ssh\n"
        f"session, another script) is also talking to the robot at the same time."
    )


def on_robot_network() -> bool:
    """Best-effort check that this machine currently has a route to the robot's
    onboarding subnet (192.168.5.0/24) -- i.e. it's actually joined to the
    robot's own WiFi hotspot right now, not some other network. Uses a UDP
    "connect" purely to ask the OS for local routing info; sends no packets."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((HOST, 1))
            local_ip = s.getsockname()[0]
        return local_ip.startswith("192.168.5.")
    except OSError:
        return False


def main():
    print(f"== provision-wifi.py -- direct SoftAP WiFi provisioning (no app, no ADB) ==")
    print()
    warn("!! IMPORTANT: this computer must be connected to the ROBOT'S OWN onboarding")
    warn("!! WiFi network (the open, no-password hotspot it broadcasts) RIGHT NOW --")
    warn("!! not your home WiFi, not any other network. Join it from this computer's")
    warn("!! own WiFi settings first if you haven't already -- it's very easy to")
    warn("!! forget this and stay on your regular network by accident.")
    print()
    if on_robot_network():
        print(f"OK: this machine has a route to {HOST} -- looks like the robot's network.")
    else:
        warn(f"WARNING: no route to {HOST} (192.168.5.0/24) from this machine right now --")
        warn("you're very likely NOT connected to the robot's onboarding WiFi. Switch to it,")
        warn("then continue -- everything below will just time out otherwise.")
        input("Press enter once you're on the robot's WiFi network (or Ctrl-C to stop)... ")
    print()

    bean = gather_wifi_data()
    payload_json = json.dumps(bean, separators=(",", ":"))
    encrypted = aes_ecb_encrypt(payload_json.encode("utf-8"))
    b64 = base64.b64encode(encrypted)

    print()
    print(f"== Staged: {len(payload_json)} bytes JSON -> {len(b64)} bytes encrypted ==")
    print()
    print("== Ready ==")
    print("The robot's pairing window only stays open for about 7 seconds after you")
    print("enter WiFi setup mode, so:")
    print("  1. On the robot: hold both top buttons for 5+ seconds now, until it")
    print("     announces network/wifi configuration mode (if not already done).")
    print("  2. This script starts retrying the connection immediately below --")
    print("     press the buttons within a second or two of hitting enter, not before.")
    input("Press enter when you're about to (or just did) trigger the buttons... ")

    print(f"== Connecting to {HOST}:{PORT} (retrying every {CONNECT_RETRY_INTERVAL}s, "
          f"up to {CONNECT_RETRY_SECONDS}s) ==")
    sock, attempt = connect_with_retry()
    print(f"OK: connected (attempt {attempt})")

    header = build_header(WRITE_DATA_FROM_DEVICE, len(b64))
    sock.sendall(header + b64)  # one write, matching the real capture exactly
    print(f"OK: sent header (type={WRITE_DATA_FROM_DEVICE}) + {len(b64)} bytes payload")

    print("== Waiting for reply (10s timeout) ==")
    try:
        msg_type, payload = recv_message(sock)
    except (socket.timeout, ConnectionError, ValueError) as e:
        sock.close()
        sys.exit(
            f"ERROR: {e}\n"
            f"The request was sent, but no valid reply came back. The robot may still\n"
            f"have applied the WiFi credentials regardless (it persists them before\n"
            f"replying) -- check whether it actually joined your network before\n"
            f"assuming this failed outright."
        )

    print(f"OK: received type={msg_type}, {len(payload)} bytes payload")
    if msg_type != RECEIEVE_DATA_FROM_DEVICE:
        print(f"WARNING: unexpected message type {msg_type} (expected {RECEIEVE_DATA_FROM_DEVICE})")

    try:
        plaintext = aes_ecb_decrypt(base64.b64decode(payload))
        parsed = json.loads(plaintext)
    except Exception as e:
        print(f"WARNING: could not decrypt/parse the reply: {e}")
        print(f"raw hex: {payload.hex()}")
        parsed = None

    # Close out the session the same way the real app does, regardless of
    # whether the reply parsed -- the credentials are already applied either way.
    try:
        sock.sendall(build_header(STOP_CONNECT, 0))
    except OSError:
        pass
    sock.close()

    print()
    if parsed and parsed.get("sn"):
        print("== Success ==")
        print(json.dumps(parsed, indent=2))
        print()
        print(f"Robot SN: {parsed['sn']}")
        print(f"The robot should now be joining '{bean['ssid']}'. To confirm:")
        print(f"  - Check your router's DHCP client list for a new device.")
        print(f"  - Once it has an IP: ssh root@<new-ip>, then")
        print(f"    wpa_cli -i wlan0 status  (look for wpa_state=COMPLETED)")
    else:
        print("== Connection completed, but no confirmed success reply ==")
        print("The robot likely still applied the credentials (it writes them to disk")
        print("before replying), even though this script couldn't confirm it. Check")
        print("whether the robot actually joined your WiFi network before retrying.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        warn("Interrupted (Ctrl-C) -- stopping.")
        sys.exit(130)
