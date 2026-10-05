# Changelog

## 0.2.0 - 2026-10-05

### Added

- First-run model setup inside `/ysk`, with searchable ranking and chat model lists.
- Automatic configuration-file creation after the user confirms their choices.
- Login guidance when selected providers have no configured credentials.
- Package preview image for the Pi package catalog.
- npm package contents limited to the extension, preview, and user documentation.

### Changed

- Existing configuration is preserved, including concurrent setup from another session.
- A missing configuration now opens setup instead of silently selecting model defaults.
- Installation documentation describes provider login and first-run setup.

## 0.1.0 - 2026-10-05

- Initial private session briefing and tool-less follow-up chat.
- Jev importance ranking and configurable briefing/discussion models.
- Bounded recent-session evidence, latest-result reuse, and safe request cancellation.
- Bordered modal with padding, scrolling, and a separate follow-up input area.
