# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

Read-only **Plugin list** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `all`; the Plugins section owns the navigation entry and tab chrome. It performs no Remote read during plugin activation. Selecting the tab for the first time mounts it and lazily calls `ctx.remote.pluginInventory.list()` through [`api-remotes`](../../api/remotes/README.md).

The tab renders a searchable two-column catalog of compact disclosure cards with functional category filters. The categories are Tools, Agents & orchestration, Models & context, Sessions & storage, Web interface, Runtime, and Other. Buttons show total category counts, and category and search filters apply together. Official DSH and Cordis modules are categorized by stable package-name prefixes; unrecognized third-party and local modules go to Other.

Each collapsed card uses the short module name as its title and a small effective-enablement tag; enabled entries also show a colored root-fiber status dot. Expanding one card reveals its Loader-tree entry id without a redundant field label, followed by its category, effective configuration, and, for enabled entries, Cordis status. Disabled entries omit the redundant unmounted runtime state. The entry id remains the React key, disclosure identity, detail value, and an additional search target. Loading, empty, no-match, and generic failure states stay local to the mounted component, and a failed read can be retried without exposing transport details. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One snapshot per Settings mount or retry** — the tab does not subscribe to Loader changes or automatically refetch after reconnect; switching tabs preserves the current snapshot, while reopening Settings obtains a new one.
- **Read-only Loader view** — functional categories derive from official package-name prefixes and do not represent runtime contribution relationships; the view does not provide provenance groups, current-browser activation diagnosis, or plugin mutation controls.
