/**
 * Jest global setup.
 *
 * The plugin resolves the jbcontext binary from the merged opencode config,
 * but tests exercise path handling through mocks. Pin the environment so
 * path resolution is deterministic everywhere (CI runners may export
 * XDG_CONFIG_HOME or OPENCODE_CONFIG_DIR).
 */
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.XDG_CONFIG_HOME;