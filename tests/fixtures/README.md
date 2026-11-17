`proxy-test-cert.pem` / `proxy-test-key.pem` are a self-signed localhost
certificate used only by `tests/systemProxy.test.ts` to exercise the CONNECT
tunnel against a local HTTPS origin. They are test data, not deployment
credentials; the private key is intentionally committed so the test does not
depend on `openssl` at runtime.
