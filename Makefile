.PHONY: release

# Interactive: asks patch or minor, tags, pushes, waits for CI, publishes.
release:
	@scripts/release.sh
