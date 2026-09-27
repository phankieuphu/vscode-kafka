# Change Log

All notable changes to the "kafka-manager" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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

## [0.0.4] - 2026-09-24

### Added

- CI/CD pipeline: tests on Linux, Windows and macOS, packages the .vsix, and publishes to the Marketplace on `v*` tags

### Fixed

- Test build compilation
- Cluster name not updating after rename (#2)

## [0.0.1]

- Initial release
