# Changelog

## 1.0.0 (2026-11-12)


### Features

* **admin:** production on admin.brickplace.app behind its own Access application ([b643e6e](https://github.com/ndk98z/brickplace/commit/b643e6eacf7fb4ae9d001e9e5b8a95a4409912d7))
* **bots:** staging behind Cloudflare Access, for invited testers ([b442bf5](https://github.com/ndk98z/brickplace/commit/b442bf560dce4232e46588cacefdfcccc1ce4f0a))
* **gateway:** production on brickplace.app with Discord and Google sign-in ([185f9a9](https://github.com/ndk98z/brickplace/commit/185f9a9883175be66537964314d464cd8abe400b))
* **gateway:** production reads the map from tiles.brickplace.app ([f937d26](https://github.com/ndk98z/brickplace/commit/f937d264e7396ac9d091a72686988e2656daa327))
* **gateway:** production runs 10 FanoutDO shards, sized for 20,000 players ([a3b5a74](https://github.com/ndk98z/brickplace/commit/a3b5a74d5a8334adb23690ec2d6c82ae6bd6e518))


### Bug Fixes

* **client:** the manifest carries the Access cookie; admin login pinned before the PIN ([0174628](https://github.com/ndk98z/brickplace/commit/01746286a0a1a9cf38c3e7abd2f721e8c012fa6b))
* **deps:** drop the undici and zod overrides ([69a7229](https://github.com/ndk98z/brickplace/commit/69a7229b8f5f076afdc2632f2ea9c973119586b2))
* **deps:** raise undici and zod past known advisories ([1019b0a](https://github.com/ndk98z/brickplace/commit/1019b0a380a82bda8149eac95c8364ee28619526))
