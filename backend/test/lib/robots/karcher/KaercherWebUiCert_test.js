const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");
const { once } = require("node:events");

const KaercherWebUiCert = require("../../../../lib/robots/karcher/KaercherWebUiCert");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 9, 1, 12));
const OPTIONS = {
    hostnames: ["valetudo-test.local", "localhost"],
    ips: ["127.0.0.1", "192.168.1.50", "not-an-ip"],
    now: NOW
};

describe("KaercherWebUiCert", () => {
    describe("IS_CLOCK_SANE()", () => {
        it("rejects a clock that hasn't been set yet", () => {
            assert.strictEqual(KaercherWebUiCert.IS_CLOCK_SANE(new Date(Date.UTC(2022, 0, 1))), false);
        });

        it("accepts a current clock", () => {
            assert.strictEqual(KaercherWebUiCert.IS_CLOCK_SANE(NOW), true);
        });
    });

    describe("GENERATE()", () => {
        it("produces a self-signed cert with matching key, SANs and a sub-825-day validity", async () => {
            const generated = await KaercherWebUiCert.GENERATE(OPTIONS);
            const x509 = new crypto.X509Certificate(generated.cert);
            const validFrom = new Date(x509.validFrom);
            const validTo = new Date(x509.validTo);

            assert.strictEqual(x509.checkPrivateKey(crypto.createPrivateKey(generated.key)), true);
            assert.strictEqual(x509.verify(x509.publicKey), true);
            assert.strictEqual(x509.subject, "CN=valetudo-test.local");
            assert.strictEqual(
                x509.subjectAltName,
                "DNS:valetudo-test.local, DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.50"
            );
            assert.strictEqual(validFrom.getTime(), NOW.getTime() - DAY_MS);
            assert.ok(validTo.getTime() - validFrom.getTime() < 825 * DAY_MS);
            assert.ok(validTo.getTime() - NOW.getTime() > 800 * DAY_MS);
        });

        it("works as a real HTTPS server cert, verifiable against itself by IP SAN", async () => {
            const generated = await KaercherWebUiCert.GENERATE(OPTIONS);
            const server = https.createServer(generated, (req, res) => {
                res.end("ok");
            });

            server.listen(0, "127.0.0.1");
            await once(server, "listening");

            try {
                const body = await new Promise((resolve, reject) => {
                    https.get({
                        host: "127.0.0.1",
                        port: server.address().port,
                        // Trusting the cert as its own CA also proves the 127.0.0.1 IP SAN matches
                        ca: generated.cert
                    }, res => {
                        let data = "";

                        res.on("data", chunk => {
                            data += chunk;
                        });
                        res.on("end", () => {
                            resolve(data);
                        });
                    }).on("error", reject);
                });

                assert.strictEqual(body, "ok");
            } finally {
                server.close();
            }
        });
    });

    describe("NEEDS_RENEWAL()", () => {
        it("is false for a fresh cert and true near or past expiry", async () => {
            const {cert} = await KaercherWebUiCert.GENERATE(OPTIONS);
            const validTo = new Date(new crypto.X509Certificate(cert).validTo);

            assert.strictEqual(KaercherWebUiCert.NEEDS_RENEWAL(cert, NOW), false);
            assert.strictEqual(KaercherWebUiCert.NEEDS_RENEWAL(cert, new Date(validTo.getTime() - 10 * DAY_MS)), true);
            assert.strictEqual(KaercherWebUiCert.NEEDS_RENEWAL(cert, new Date(validTo.getTime() + DAY_MS)), true);
        });
    });

    describe("LOAD_OR_GENERATE()", () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaercher-webui-cert-"));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        });

        function pathOptions(now) {
            return Object.assign({}, OPTIONS, {
                certPath: path.join(tmpDir, "webui.crt"),
                keyPath: path.join(tmpDir, "webui.key"),
                now: now
            });
        }

        it("generates and persists on first run, then reuses the same cert", async () => {
            const first = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(NOW));
            const second = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(NOW));

            assert.strictEqual(fs.readFileSync(path.join(tmpDir, "webui.crt"), "utf8"), first.cert);
            assert.strictEqual(fs.statSync(path.join(tmpDir, "webui.key")).mode & 0o777, 0o600);
            assert.strictEqual(second.cert, first.cert);
            assert.strictEqual(second.key, first.key);
        });

        it("regenerates when the persisted files are corrupt or mismatched", async () => {
            const first = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(NOW));

            fs.writeFileSync(path.join(tmpDir, "webui.crt"), "-----BEGIN CERTIFICATE-----\ntruncated");
            const afterCorruption = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(NOW));

            assert.notStrictEqual(afterCorruption.cert, first.cert);

            const other = await KaercherWebUiCert.GENERATE(OPTIONS);

            fs.writeFileSync(path.join(tmpDir, "webui.key"), other.key);
            const afterMismatch = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(NOW));
            const x509 = new crypto.X509Certificate(afterMismatch.cert);

            assert.strictEqual(x509.checkPrivateKey(crypto.createPrivateKey(afterMismatch.key)), true);
            assert.strictEqual(fs.existsSync(path.join(tmpDir, "webui.crt.new")), false);
        });

        it("renews a cert that is close to expiry", async () => {
            const first = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(NOW));
            const nearExpiry = new Date(NOW.getTime() + 815 * DAY_MS);
            const renewed = await KaercherWebUiCert.LOAD_OR_GENERATE(pathOptions(nearExpiry));

            assert.notStrictEqual(renewed.cert, first.cert);
            assert.strictEqual(KaercherWebUiCert.NEEDS_RENEWAL(renewed.cert, nearExpiry), false);
        });
    });
});
