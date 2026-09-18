# vscode-kafka

Manage Apache Kafka clusters directly from VS Code: connect to one or more clusters, browse topics and partitions, inspect consumer groups and their lag, produce messages, and tail live traffic — all from a sidebar tree and a message-browser panel.

## Features

- **Cluster explorer** — a "Kafka" activity bar view lists your configured clusters. Connect/disconnect per cluster from inline icons.
- **Topics** — expand a cluster to see its topics, and a topic to see its partitions (leader, replicas, in-sync replicas).
- **Consumer groups** — expand "Consumer Groups" to see each group and its per-partition committed offset, high-water mark, and lag.
- **Message browser** — click a topic to open a panel that can load the most recent messages per partition, tail new messages live, and produce a new message with an optional key.
- **Topic management** — create and delete topics from the tree's context menu.

## Requirements

Network access to your Kafka broker(s). No local Kafka installation is required by the extension itself — it talks to brokers over the wire via [KafkaJS](https://kafka.js.org/).

## Getting started

1. Open the Kafka view in the activity bar.
2. Click **Add Cluster** (`+`) and enter a name and comma-separated broker list, e.g. `localhost:9092`.
3. Click the connect icon on the cluster to connect.
4. Expand **Topics** or **Consumer Groups** to browse, or click a topic to open its message browser.

## Extension Settings

* `kafka.clusters`: array of `{ id, name, brokers }` entries. Normally managed via the **Kafka: Add Cluster** / **Kafka: Remove Cluster** commands, but can be hand-edited in `settings.json`.

## Known Issues

- Authenticated clusters (SASL/SSL) are not yet supported — only plaintext broker connections.
- The message browser's "Load Recent" reads from the end of each partition using a throwaway consumer group, so it never affects real consumer group offsets, but very large messages or very high-throughput topics may take a moment to load.

## Release Notes

### 0.0.1

Initial release: cluster explorer, topic/partition browsing, consumer group lag, message tailing and producing, topic create/delete.
