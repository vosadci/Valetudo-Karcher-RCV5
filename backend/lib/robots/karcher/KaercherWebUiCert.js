const crypto = require("crypto");
const forge = require("node-forge");
const fs = require("fs");
const net = require("net");
const util = require("util");

const Logger = require("../../Logger");

const generateKeyPair = util.promisify(crypto.generateKeyPair);

/**
 * Self-signed cert for the web UI's HTTPS listener, generated on the robot (it has no
 * openssl CLI). Validity stays under Apple's 825-day cap, which macOS/iOS enforce on
 * every TLS server cert (support.apple.com/HT210176; mkcert uses 2y3m for the same
 * reason). That ties notBefore to the current time, so callers must check
 * IS_CLOCK_SANE() first: the robot's clock may be wrong until NTP has synced.
 */
class KaercherWebUiCert {
    /**
     * @param {Date} now
     * @return {boolean}
     */
    static IS_CLOCK_SANE(now) {
        return now.getTime() >= KaercherWebUiCert.CLOCK_FLOOR.getTime();
    }

    /**
     * @param {string} certPem
     * @param {Date} now
     * @return {boolean} true when the cert is expired or expires within RENEW_BEFORE_MS
     */
    static NEEDS_RENEWAL(certPem, now) {
        const validTo = new Date(new crypto.X509Certificate(certPem).validTo);

        return validTo.getTime() - now.getTime() < KaercherWebUiCert.RENEW_BEFORE_MS;
    }

    /**
     * @param {object} options
     * @param {Array<string>} options.hostnames first one becomes the subject CN
     * @param {Array<string>} options.ips
     * @param {Date} options.now
     * @return {Promise<{cert: string, key: string}>}
     */
    static async GENERATE(options) {
        // Native keygen: forge's pure-JS RSA keygen is far slower on the Cortex-A7
        const {privateKey} = await generateKeyPair("rsa", {
            modulusLength: 2048,
            privateKeyEncoding: {type: "pkcs1", format: "pem"},
            publicKeyEncoding: {type: "spki", format: "pem"}
        });
        const forgeKey = forge.pki.privateKeyFromPem(privateKey);
        const cert = forge.pki.createCertificate();

        cert.publicKey = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
        cert.serialNumber = "01" + crypto.randomBytes(19).toString("hex"); // rfc5280 4.1.2.2
        cert.validity.notBefore = new Date(options.now.getTime() - KaercherWebUiCert.BACKDATE_MS);
        cert.validity.notAfter = new Date(cert.validity.notBefore.getTime() + KaercherWebUiCert.VALIDITY_MS);

        const subject = [{name: "commonName", value: options.hostnames[0]}];
        const altNames = [
            ...options.hostnames.map(value => {
                return {type: 2, value: value};
            }),
            ...options.ips.filter(ip => {
                return net.isIP(ip) !== 0;
            }).map(ip => {
                return {type: 7, ip: ip};
            })
        ];

        cert.setSubject(subject);
        cert.setIssuer(subject);
        cert.setExtensions([
            {name: "basicConstraints", cA: false},
            {name: "keyUsage", digitalSignature: true, keyEncipherment: true},
            {name: "extKeyUsage", serverAuth: true},
            {name: "subjectAltName", altNames: altNames}
        ]);
        cert.sign(forgeKey, forge.md.sha256.create());

        return {
            cert: forge.pki.certificateToPem(cert),
            key: privateKey
        };
    }

    /**
     * Reuses the persisted cert so browsers keep their accepted exception across
     * reboots. Only regenerates when the files are missing or the cert is close to
     * expiry — never because the robot's IPs changed.
     *
     * @param {object} options
     * @param {string} options.certPath
     * @param {string} options.keyPath
     * @param {Array<string>} options.hostnames
     * @param {Array<string>} options.ips
     * @param {Date} options.now
     * @return {Promise<{cert: string, key: string}>}
     */
    static async LOAD_OR_GENERATE(options) {
        let existing;

        try {
            existing = {
                cert: fs.readFileSync(options.certPath, "utf8"),
                key: fs.readFileSync(options.keyPath, "utf8")
            };
        } catch (e) {
            if (e.code !== "ENOENT") {
                throw e;
            }
        }

        if (existing) {
            try {
                const x509 = new crypto.X509Certificate(existing.cert);

                if (!x509.checkPrivateKey(crypto.createPrivateKey(existing.key))) {
                    Logger.warn("KaercherWebUiCert: web UI cert and key don't match, generating a new pair");
                } else if (KaercherWebUiCert.NEEDS_RENEWAL(existing.cert, options.now)) {
                    Logger.info("KaercherWebUiCert: web UI cert expires soon, generating a new one");
                } else {
                    return existing;
                }
            } catch (e) {
                Logger.warn("KaercherWebUiCert: web UI cert or key is unreadable, generating a new pair", e.message);
            }
        } else {
            Logger.info("KaercherWebUiCert: no web UI cert yet, generating one");
        }

        const start = Date.now();
        const generated = await KaercherWebUiCert.GENERATE(options);

        Logger.info(`KaercherWebUiCert: generated web UI cert in ${Date.now() - start}ms`);

        // Write-then-rename so a power cut can't leave a half-written file behind
        fs.writeFileSync(options.keyPath + ".new", generated.key, {mode: 0o600});
        fs.writeFileSync(options.certPath + ".new", generated.cert);
        fs.renameSync(options.keyPath + ".new", options.keyPath);
        fs.renameSync(options.certPath + ".new", options.certPath);

        return generated;
    }
}

// Anything before this means the clock hasn't been set yet
KaercherWebUiCert.CLOCK_FLOOR = new Date(Date.UTC(2026, 0, 1));
KaercherWebUiCert.BACKDATE_MS = 24 * 60 * 60 * 1000;
// 2 years 3 months, under Apple's 825-day limit
KaercherWebUiCert.VALIDITY_MS = 820 * 24 * 60 * 60 * 1000;
KaercherWebUiCert.RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

module.exports = KaercherWebUiCert;
