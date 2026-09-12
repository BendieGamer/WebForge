# WebFabric

WebFabric is a port of Minecraft 1.6.4 on [LegacyFabric](https://legacyfabric.net/) to the web browser. It runs Fabric Loader 0.18.2 with Mixin, so it loads mods built for LegacyFabric 1.6.4.

This was previously WebForge, which ran Minecraft Forge instead. **Forge mods no longer work** — mods have to be built for LegacyFabric 1.6.4. Mods ship with the launcher and are installed into the mods folder automatically; there is no upload step. Currently bundled: the [Legacy Fabric API](https://modrinth.com/mod/legacy-fabric-api). Add a jar to `BUNDLED_MODS` in `minecraft-web.js` to ship another.

Mods have to be **Java 8 bytecode**. CheerpJ can boot Java 17, but Fabric Loader's mod resolver throws `ArrayIndexOutOfBoundsException` out of `findCompatibleSet` on it and nothing loads at all, so anything declaring `java >=17` is out of reach. That rules out every BTW:CE 3.x release: 3.0.0 through 3.1.1 are all Java 17 bytecode declaring `java >=17 <=21`.


The offline download runs straight off disk — open `webfabric_offline.html` from the file manager, no server needed. CheerpJ's `/files/` mount is IndexedDB-backed and Chrome allows IndexedDB on `file://` pages, so the game directory works there.

Play it [here](https://cucuzacu.github.io/WebForge). Join the [Discord server](https://discord.gg/QCAEMtnqws).

## How it works

Everything runs on [CheerpJ](https://cheerpj.com/), which is a Java 8 runtime. That is the constraint the whole port is built around, and LegacyFabric fits inside it: its metadata for 1.6.4 declares `min_java_version: 8`, and every class in the loader stack is class-file v52 or lower except `module-info` entries and multi-release classes that Java 8 never loads.

Two things happen at build time rather than in the browser:

- **The game jar is remapped ahead of time**, from the official namespace to LegacyFabric's intermediary namespace. If it were not, Fabric Loader would run tiny-remapper over ~1500 classes inside CheerpJ on first launch and write the result back through IndexedDB. Because the jar arrives already correct, `fabric.gameMappingNamespace=intermediary` makes the loader skip deobfuscation entirely.
- **The game and its libraries are split into separate jars.** The old `mc.jar` merged them together along with Forge's launchwrapper, its ASM, and the Scala runtime FML shipped for mods. Dropping those cut roughly 21 MB.

`natives/lwjgl.js` carries over from WebForge. It is a JavaScript reimplementation of LWJGL 2.9.0's JNI entry points that maps fixed-function OpenGL onto WebGL2, and Fabric does not touch LWJGL.

One thing in it did change: display lists now keep their geometry in a GPU buffer. Minecraft compiles a chunk into a display list once and then replays it every frame, but the shim used to re-upload the whole list's vertex data on each `glCallList`, which is several `bufferSubData` calls and a full CPU-to-GPU copy per visible chunk per frame. The list now uploads once, on first replay, and afterwards only rebinds. The buffers are released in `glNewList`, since Minecraft recompiles a chunk's list whenever its blocks change.

`JAVA_VERSION` in `minecraft-web.js` picks the JDK CheerpJ boots. It is `8`; see the note above on why 17 does not work.

## Layout

| File | What it is |
| --- | --- |
| `minecraft-1.6.4-intermediary.jar` | Vanilla 1.6.4, remapped to the intermediary namespace |
| `minecraft-1.6.4-libraries.jar` | The libraries 1.6.4 shipped with |
| `fabric-loader-0.18.2.jar` | Fabric Loader |
| `sponge-mixin-0.17.3.jar`, `asm-*.jar` | Mixin and its ASM dependencies |
| `intermediary-1.6.4.jar` | LegacyFabric intermediary mappings |
| `legacy-fabric-api-1.13.5.jar` | Bundled API, installed into the mods folder on launch |
| `natives/lwjgl.js` | LWJGL 2.9.0 natives, reimplemented on WebGL2 |
| `tools/` | Build scripts for the two Minecraft jars |

## Building

To rebuild the Minecraft jars, which pulls the game and its libraries straight from Mojang and the loader stack from the Fabric and LegacyFabric maven repos (needs a JDK 8 on `PATH`):

```
python3 tools/buildgamejars.py
```

To compile the offline download:

```
python3 bundleforofflinedownload.py
```

That writes `webfabric_offline.html`, a single self-contained file with every jar embedded. A precompiled copy is in the [Releases section](https://github.com/Cucuzacu/WebForge/releases/latest).
