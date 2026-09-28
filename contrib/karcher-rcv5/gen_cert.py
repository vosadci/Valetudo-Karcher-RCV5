#!/usr/bin/env python3
#
# Generates the dev TLS cert `aiot_client` needs: a self-signed cert for
# *.3irobotix.net, then downgraded to a genuine ASN.1 v1 cert (the two-step
# process folded into one script — mbedTLS on the robot rejects the v3 cert
# every modern TLS library emits by default, and cryptography has no "emit
# v1" option, so the version field is stripped from the DER by hand after
# the fact).
#
# Idempotent: does nothing if all four output files already exist. Pass
# --force to regenerate. Outputs are written to *.tmp and atomically renamed
# into place together, so a Ctrl-C mid-run never leaves a mismatched
# key/cert/v1-cert set lying around — either all four land, or none do.
#
# Always resolves paths relative to this script's own directory, so it's
# safe to invoke from anywhere (`.../contrib/karcher-rcv5/gen_cert.py`),
# not just from inside this directory.

import argparse
import base64
import datetime
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

OUTPUTS = ["server.key", "server.crt", "server_v1.crt", "server_v1.der"]


def read_len(b, off):
    length = b[off]
    if length < 0x80:
        return length, off + 1
    n = length & 0x7F
    val = int.from_bytes(b[off + 1 : off + 1 + n], "big")
    return val, off + 1 + n


def encode_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def generate_v3_cert():
    key = ec.generate_private_key(ec.SECP256R1())

    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
            x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "GD"),
            x509.NameAttribute(NameOID.LOCALITY_NAME, "SZ"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "3irobotix"),
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "IOT"),
            x509.NameAttribute(NameOID.COMMON_NAME, "*.3irobotix.net"),
            x509.NameAttribute(NameOID.EMAIL_ADDRESS, "aiot_faq@3irobotics.com"),
        ]
    )

    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=3650)
        )
    )
    # no extensions added at all -> cryptography still emits v3; downgrade_to_v1()
    # strips the version field afterward to produce the genuine v1 cert
    # aiot_client's mbedTLS stack requires.
    cert = builder.sign(key, hashes.SHA256())
    return key, cert


def downgrade_to_v1(key, cert):
    der = cert.public_bytes(serialization.Encoding.DER)

    assert der[0] == 0x30
    _outer_len, outer_content_off = read_len(der, 1)

    tbs_off = outer_content_off
    assert der[tbs_off] == 0x30
    tbs_len, tbs_content_off = read_len(der, tbs_off + 1)
    tbs_content = der[tbs_content_off : tbs_content_off + tbs_len]

    # version field: context [0] constructed at the start of tbs_content
    assert tbs_content[0] == 0xA0, hex(tbs_content[0])
    ver_len, ver_content_off_rel = read_len(tbs_content, 1)
    ver_tlv_len = ver_content_off_rel + ver_len

    new_tbs_content = tbs_content[ver_tlv_len:]
    new_tbs_tlv = b"\x30" + encode_len(len(new_tbs_content)) + new_tbs_content

    signature = key.sign(new_tbs_tlv, ec.ECDSA(hashes.SHA256()))

    sigalg_tlv = bytes.fromhex("300a06082a8648ce3d040302")  # ecdsa-with-SHA256, no params
    sig_bitstring_content = b"\x00" + signature
    sig_bitstring_tlv = b"\x03" + encode_len(len(sig_bitstring_content)) + sig_bitstring_content

    outer_content = new_tbs_tlv + sigalg_tlv + sig_bitstring_tlv
    new_der = b"\x30" + encode_len(len(outer_content)) + outer_content

    pem = "-----BEGIN CERTIFICATE-----\n"
    b64 = base64.b64encode(new_der).decode()
    for i in range(0, len(b64), 64):
        pem += b64[i : i + 64] + "\n"
    pem += "-----END CERTIFICATE-----\n"

    return new_der, pem


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force", action="store_true", help="regenerate even if outputs already exist"
    )
    args = parser.parse_args()

    out_paths = {name: os.path.join(SCRIPT_DIR, name) for name in OUTPUTS}

    if not args.force and all(os.path.exists(p) for p in out_paths.values()):
        print("certs already present, doing nothing (pass --force to regenerate):")
        for name in OUTPUTS:
            print(f"  {out_paths[name]}")
        return

    key, cert = generate_v3_cert()
    v1_der, v1_pem = downgrade_to_v1(key, cert)

    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)

    contents = {
        "server.key": key_pem,
        "server.crt": cert_pem,
        "server_v1.crt": v1_pem.encode(),
        "server_v1.der": v1_der,
    }

    tmp_paths = {}
    try:
        for name, data in contents.items():
            tmp_path = out_paths[name] + ".tmp"
            mode = "wb"
            with open(tmp_path, mode) as f:
                f.write(data)
            tmp_paths[name] = tmp_path
        for name, tmp_path in tmp_paths.items():
            os.replace(tmp_path, out_paths[name])
    finally:
        for tmp_path in tmp_paths.values():
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    print("wrote:")
    for name in OUTPUTS:
        print(f"  {out_paths[name]}")
    print("cert version:", cert.version, "/ v1 der bytes:", len(v1_der))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        print("Interrupted (Ctrl-C) -- stopping.")
        sys.exit(130)
