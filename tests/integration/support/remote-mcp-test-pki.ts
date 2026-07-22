import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RemoteMcpTestPki {
  caCertificate: Buffer;
  clientCertificate: Buffer;
  clientFingerprintSha256: string;
  clientPrivateKey: Buffer;
  close(): void;
  serverCertificate: Buffer;
  serverPrivateKey: Buffer;
  unpinnedClientCertificate: Buffer;
  unpinnedClientPrivateKey: Buffer;
}

function runOpenSsl(argumentsValue: readonly string[]): void {
  execFileSync("openssl", [...argumentsValue], { stdio: "ignore" });
}

function createLeaf(
  directory: string,
  name: string,
  serial: number,
  extensions: readonly string[],
): void {
  const keyPath = join(directory, `${name}.key.pem`);
  const requestPath = join(directory, `${name}.csr.pem`);
  const certificatePath = join(directory, `${name}.cert.pem`);
  const extensionsPath = join(directory, `${name}.ext.cnf`);
  writeFileSync(extensionsPath, `[leaf]\n${extensions.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  runOpenSsl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    name === "server" ? "/CN=127.0.0.1" : "/CN=alphanet-mcp",
    "-keyout",
    keyPath,
    "-out",
    requestPath,
  ]);
  runOpenSsl([
    "x509",
    "-req",
    "-sha256",
    "-days",
    "2",
    "-in",
    requestPath,
    "-CA",
    join(directory, "ca.cert.pem"),
    "-CAkey",
    join(directory, "ca.key.pem"),
    "-set_serial",
    String(serial),
    "-extfile",
    extensionsPath,
    "-extensions",
    "leaf",
    "-out",
    certificatePath,
  ]);
}

/** Creates one short-lived CA with a pinned and an unpinned MCP client leaf. */
export function createRemoteMcpTestPki(): RemoteMcpTestPki {
  const directory = mkdtempSync(join(tmpdir(), "alphanet-remote-mcp-pki-"));
  try {
    runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=AlphaNet Remote MCP integration CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      join(directory, "ca.key.pem"),
      "-out",
      join(directory, "ca.cert.pem"),
    ]);

    createLeaf(directory, "server", 1001, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]);
    const clientExtensions = [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      "subjectAltName=URI:spiffe://alphanet.internal/service/mcp",
    ] as const;
    createLeaf(directory, "client", 1002, clientExtensions);
    createLeaf(directory, "unpinned-client", 1003, clientExtensions);

    const caCertificate = readFileSync(join(directory, "ca.cert.pem"));
    const clientCertificate = readFileSync(join(directory, "client.cert.pem"));
    return {
      caCertificate,
      clientCertificate,
      clientFingerprintSha256: new X509Certificate(
        clientCertificate,
      ).fingerprint256.replaceAll(":", ""),
      clientPrivateKey: readFileSync(join(directory, "client.key.pem")),
      close() {
        rmSync(directory, { force: true, recursive: true });
      },
      serverCertificate: readFileSync(join(directory, "server.cert.pem")),
      serverPrivateKey: readFileSync(join(directory, "server.key.pem")),
      unpinnedClientCertificate: readFileSync(
        join(directory, "unpinned-client.cert.pem"),
      ),
      unpinnedClientPrivateKey: readFileSync(join(directory, "unpinned-client.key.pem")),
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}
