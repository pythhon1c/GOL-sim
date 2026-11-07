# Security

Report vulnerabilities privately to **ggggggdev@gmail.com**. Include the affected
version, reproduction steps and expected impact. Do not include live tokens,
personal worlds, private paths or unrelated personal information in public issues.

The server binds to `127.0.0.1` by default. External binding requires the
`LIFE_ACCESS_TOKEN` environment variable. Keep tokens out of configuration files
and Git. Use a trusted TLS reverse proxy or VPN for remote access; the built-in
HTTP server does not supply transport encryption. Keep the service and its
working directory accessible only to trusted users.

The application serves its assets locally. Pattern source links open external
websites only when followed. Browser preferences and editor drafts remain in the
browser; server imports, checkpoints and logs remain on the server unless you
export or share them. The standalone editor can be used without a server.

The publication exporter uses an explicit source allowlist, excludes runtime
data, and checks its output for common secret and private-path patterns. This is
a repeatable check, not a guarantee against every possible kind of sensitive data.
