# Change Log

All notable changes to the "kafka-manager" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.3.0] - 2026-10-12

### Added

- Browse messages from the oldest offset, a specific offset or a point in time, on all partitions or one, and page with **Load older** / **Load newer** (#19)
- **Search topic**: scan up to 100k messages per partition for text in the key, value or headers, with progress and Cancel (#19)
- Schema Registry support: decode Avro, Protobuf and JSON Schema values in the Confluent wire format, show the schema id and subject, pick a key/value format (Auto, String, JSON, Avro, Protobuf, JSON Schema, Hex, Base64), and encode a JSON value with a subject's latest schema when producing (#18)
- Export the messages shown as JSON or NDJSON, produce a batch from a JSON array or NDJSON file with progress, and copy a message as a kcat command (#20)
- Edit topic settings inline with a confirmation diff, reset a setting to its default, add partitions, and set `cleanup.policy` / `retention.ms` when creating a topic (#21)
- Save clusters to workspace settings to share them with a team; the tooltip shows where each cluster is saved. Workspace clusters are ignored until the workspace is trusted (#22)
- Produce templates per topic, `{{uuid}}`, `{{now}}`, `{{nowMs}}`, `{{random.int}}` and `{{seq}}` variables, and send ×N with a delay (#23)
- Lag alerts: **Watch Lag…** on a consumer group, checked in the background while connected, with one notification per crossing and a status bar warning until it recovers (`kafka.lagAlerts`, `kafka.lagAlertIntervalSeconds`) (#24)
- Brokers node and broker details (role, leader/replica counts, settings and their source), and a read-only, filterable ACL list (#25)
- Mutual TLS with a client certificate and key (e.g. Aiven) (#17)
- Integration tests for `ClusterManager` against a real Kafka broker, run in CI on Linux (#26)

### Fixed

- The message browser and live tail left a consumer group behind on the cluster for every load, which then showed up with false "has lag but no members" warnings. They no longer commit offsets, delete their group afterwards, and `vscode-kafka-*` groups are hidden (#11)
- Hand edits to `kafka.clusters` now refresh the tree and status bar straight away, and removing a cluster by hand disconnects it (#12)
- Topic and group panels now follow their cluster: disconnecting stops a live tail and shows a disconnected banner with Connect, removing the cluster closes them, and renames update them. A topic deleted while its panel is open gives a clear error instead of a `TypeError` (#13)
- Consumer lag was overstated for partitions with no committed offset (counted from offset 0 instead of the oldest retained message) and could be negative after a topic was truncated; one shared calculation is now used by the tree, group panel, dashboard and reset preview (#14)
- Producing disconnected the shared producer after every message
- Create Topic could report "This server does not host this topic-partition" although the topic had been created, when the broker didn't yet know about it

## [0.2.0] - 2026-09-30

### Added

- Secured clusters: TLS (system CAs, a custom CA file, or unverified for dev), SASL/PLAIN, SASL/SCRAM-SHA-256/512 and Amazon MSK IAM. Add Cluster asks for the security settings and suggests one from the port/host; **Edit Connection Security…** changes them later
- SASL passwords are stored in VS Code's secret storage, and asked for on connect when missing
- Connection errors come with a hint about the likely cause: wrong auth or TLS mode, untrusted certificate, Docker `advertised.listeners`, container not running or port not published, MSK VPC reachability, missing AWS credentials
- Reconnect action on clusters in the error state, and a notification with Reconnect when a connection is lost

### Fixed

- A lost broker connection wasn't detected; the cluster stayed "connected" while every operation failed
- Refused connections showed as a bare "Connection error: " with no reason
- Editing a cluster's brokers in `settings.json` had no effect until VS Code was reloaded

## [0.1.0] - 2026-09-27

### Added

- Cluster dashboard: health summary tiles, problem banner, broker leader distribution, topic sizes and partition health, and consumer-group lag in one panel, with filtering, sorting, auto-refresh and click-through to topic/group panels
- Dashboard states for disconnected, first load, failed refresh (stale data kept, auto-refresh paused after 3 failures) and filters with no matches
- Status bar item showing connected clusters and open issues
- Explorer: welcome view, topic health dots and tooltips, cluster descriptions with the last connection error, and Copy Bootstrap Servers, Rename and Create Topic in the cluster menu
- Add Cluster validates `host:port` addresses and connects immediately
- Topic panel redesign: Messages/Partitions/Configuration tabs, live tail with pause, partition filter and search, message detail with headers and highlighted JSON, produce with partition and headers
- Consumer group panel redesign: members with assignments, per-partition lag, and a Reset Offsets panel (earliest, latest, timestamp, shift by N) with a preview

### Fixed

- Rename Cluster always failed with "Please choose correct cluster"
- Create Topic reported success when the topic already existed; failures are now logged to the output channel
- A failed connection attempt left the admin client open
- Consumer group offsets not refreshing correctly

## [0.0.4] - 2026-09-24

### Added

- CI/CD pipeline: tests on Linux, Windows and macOS, packages the .vsix, and publishes to the Marketplace on `v*` tags

### Fixed

- Test build compilation
- Cluster name not updating after rename (#2)

## [0.0.1]

- Initial release
