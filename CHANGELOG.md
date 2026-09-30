# Change Log

All notable changes to the "kafka-manager" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
