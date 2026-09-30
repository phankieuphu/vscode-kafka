# vscode-kafka

Manage Apache Kafka clusters directly from VS Code: connect to one or more clusters, browse topics and partitions, inspect consumer groups and their lag, produce messages, and tail live traffic — all from a sidebar tree and a message-browser panel.

![Cluster dashboard](docs/images/dashboard.png)

## Features

- **Cluster dashboard** — click the dashboard icon on a connected cluster (or run **Kafka: Open Cluster Dashboard**, or click the Kafka item in the status bar) for a one-page health view: an issues banner with links to the affected topics and groups, broker/topic/partition/group counts, under-replicated and offline partitions, total consumer lag, per-broker leader distribution, and sortable, filterable topic and consumer-group tables. Optional auto-refresh every 10/30/60 seconds; if refreshes keep failing, the last good data stays on screen, marked stale.
- **Cluster explorer** — a "Kafka" activity bar view lists your configured clusters with their connection state. Topics show a green/yellow/red health dot with details on hover. The cluster context menu can open the dashboard, create a topic, copy the bootstrap servers, rename or remove the cluster.
- **Guided setup** — a welcome view on first run, and a two-step **Add Cluster** input that checks every broker is `host:port` and connects right away.
- **Topic panel** — click a topic for three tabs. **Messages**: load the newest messages per partition or live-tail new ones (with pause), filter by partition or search key/value, and inspect a message's key, headers and pretty-printed JSON. **Partitions**: leader, replicas, ISR, health and offsets per partition. **Configuration**: overridden settings, with defaults on request.
- **Produce** — send a message with an optional key, target partition and headers; JSON values are checked as you type (Ctrl/Cmd+Enter sends).
- **Consumer group panel** — state, members with their assigned partitions, and lag per partition. **Reset Offsets…** moves a topic to earliest, latest, a timestamp, or shifts by N, with a preview of partitions changed and messages skipped or replayed; it's blocked while the group has active members.
- **Topic management** — create and delete topics from the tree's context menu.

## Screenshots

### Cluster dashboard

Health at a glance: open issues with links to the affected topics and groups, summary tiles, broker leadership, consumer-group lag and topic sizes.

![Cluster dashboard](docs/images/dashboard.png)

When a refresh fails, the last good data stays on screen, marked stale, with Retry and Show Output.

![Dashboard after a failed refresh](docs/images/dashboard-refresh-failed.png)

### Topic panel

Browse the newest messages or live-tail new ones, inspect a message's key, headers and JSON value, and produce messages with a key, partition and headers.

![Topic panel](docs/images/topic-panel.png)

### Consumer group panel

Members and their assigned partitions, lag per partition, and a Reset Offsets panel that previews the change before applying it.

![Consumer group panel](docs/images/consumer-group.png)

## Requirements

Network access to your Kafka broker(s). No local Kafka installation is required by the extension itself — it talks to brokers over the wire via [KafkaJS](https://kafka.js.org/).

## Getting started

1. Open the Kafka view in the activity bar.
2. Click **Add Cluster** (`+`), enter a name and comma-separated broker list, e.g. `localhost:9092`, then choose how the cluster authenticates (a choice is suggested from the port/host).
3. The cluster connects straight away; use the connect icon to reconnect later.
4. Click the dashboard icon for a health overview, expand **Topics** or **Consumer Groups** to browse, or click a topic to open its panel.

## Connecting to secured and remote clusters

| Cluster | Choose |
|---|---|
| Local / Docker (`PLAINTEXT`) | No authentication, Plaintext |
| Self-signed TLS dev cluster | No authentication, TLS, *Don't verify* or a CA file |
| Amazon MSK, port 9094 | No authentication, TLS |
| Amazon MSK, port 9096 | SASL/SCRAM-SHA-512, TLS |
| Amazon MSK, port 9098 | AWS IAM (uses your AWS credential chain or a named profile; run `aws sso login` first if you use SSO) |
| Confluent Cloud | SASL/PLAIN, TLS — the API key is the username, the secret the password |

Change these later with **Edit Connection Security…** on the cluster's context menu. Passwords are kept in VS Code's secret storage, never in `settings.json`; if a cluster has SASL configured but no saved password (for example after Settings Sync to a new machine) you're asked for it on connect.

When a connection fails, the error includes a hint about the likely cause. Common ones:

- **Docker: `getaddrinfo ENOTFOUND kafka` (or another container name).** The bootstrap server answered but advertises an address VS Code can't reach. Set `KAFKA_ADVERTISED_LISTENERS` to an address reachable from your machine (e.g. `PLAINTEXT://localhost:9092`, with a separate internal listener for other containers).
- **Docker: connection refused on localhost.** The container isn't running or the port isn't published (`-p 9092:9092`). From inside a dev container, use `host.docker.internal` instead of `localhost`.
- **Amazon MSK: timeout or host not found.** MSK brokers are private to their VPC by default. Connect over VPN or an SSH tunnel, or enable public access (ports 9194/9196/9198) and allow your IP in the security group.

## Extension Settings

* `kafka.clusters`: array of `{ id, name, brokers, ssl?, sasl? }` entries. Normally managed via the **Kafka: Add Cluster** / **Edit Connection Security…** / **Remove Cluster** commands, but can be hand-edited in `settings.json` — changes to brokers or security take effect immediately (a connected cluster reconnects). Example:

  ```json
  {
    "id": "…",
    "name": "MSK prod",
    "brokers": ["b-1.prod.abc123.c2.kafka.us-east-1.amazonaws.com:9098"],
    "sasl": { "mechanism": "aws-iam", "region": "us-east-1", "profile": "prod" }
  }
  ```

  `ssl` is `true`, or `{ "caFile": "~/certs/ca.pem" }`, or `{ "rejectUnauthorized": false }`. `sasl.mechanism` is one of `plain`, `scram-sha-256`, `scram-sha-512` (with `username`) or `aws-iam` (with `region` and optional `profile`).

## Known Issues

- Mutual TLS (client certificates), SASL/GSSAPI (Kerberos) and generic SASL/OAUTHBEARER are not supported yet.
- The message browser's "Load Recent" reads from the end of each partition using a throwaway consumer group, so it never affects real consumer group offsets, but very large messages or very high-throughput topics may take a moment to load.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

### 0.2.0

- **New: Secured clusters** — TLS (system CAs, custom CA file, or unverified for dev), SASL/PLAIN, SASL/SCRAM-SHA-256/512 and Amazon MSK IAM. Add Cluster suggests settings from the port/host; change them later with **Edit Connection Security…**. Passwords live in VS Code's secret storage.
- **Connection hints** — failures explain the likely cause and fix: wrong auth/TLS mode, untrusted certificate, Docker `advertised.listeners` or unpublished port, MSK VPC reachability, missing AWS credentials.
- **Lost connections are detected** — the cluster moves to an error state with a Reconnect action instead of staying "connected".
- **Fixes** — refused connections showing no reason, and hand edits to `kafka.clusters` needing a reload.

### 0.1.0

- **New: Cluster dashboard** — health tiles, an issues banner, broker leader distribution, topic sizes and consumer-group lag in one panel, with filtering, sorting, auto-refresh, and click-through to topic and group panels. Failed refreshes keep the last good data on screen, marked stale.
- **New: Status bar item** showing connected clusters and open issues.
- **Explorer** — welcome view, topic health dots and tooltips, last connection error on the cluster, and Copy Bootstrap Servers, Rename and Create Topic in the cluster menu. Add Cluster now validates `host:port` and connects immediately.
- **Topic panel redesign** — Messages / Partitions / Configuration tabs, live tail with pause, partition filter and search, message detail with headers and highlighted JSON, and produce with partition and headers.
- **Consumer group panel redesign** — members with assignments, per-partition lag, and Reset Offsets (earliest, latest, timestamp, shift by N) with a preview.
- **Fixes** — Rename Cluster always failing, Create Topic reporting success for an existing topic, the admin client left open after a failed connection, and consumer group offsets not refreshing.

### 0.0.4

- CI/CD: tests on Linux, Windows and macOS, `.vsix` packaging, and Marketplace publishing on `v*` tags.
- Fixed the test build and the cluster name not updating after a rename.

### 0.0.1

Initial release: cluster explorer, topic/partition browsing, consumer group lag, message tailing and producing, topic create/delete.
