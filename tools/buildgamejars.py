"""Rebuilds the two Minecraft jars that WebFabric ships.

Fabric Loader expects the game and its libraries to be separate, and it expects the game
to be in a namespace it understands. This script produces both from upstream sources, so
it needs nothing from the repository except a JDK 8 on PATH:

  minecraft-1.6.4-intermediary.jar  vanilla 1.6.4, remapped official -> intermediary
  minecraft-1.6.4-libraries.jar     the libraries Mojang shipped 1.6.4 with, merged

Remapping ahead of time is the whole trick behind this port. If the game jar arrived in
the official namespace, Fabric Loader would run tiny-remapper over ~1500 classes inside
CheerpJ on first launch and write the result back through IndexedDB. Doing it here means
the browser sees a jar that is already correct, and the loader skips deobfuscation
entirely (see fabric.gameMappingNamespace in minecraft-web.js).

Run from the repository root:

    python3 tools/buildgamejars.py
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

VERSION = "1.6.4"
LOADER_VERSION = "0.18.2"
ASM_VERSION = "9.10.1"
ASM_JARS = ["asm", "asm-analysis", "asm-commons", "asm-tree", "asm-util"]

MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
INTERMEDIARY_URL = f"https://maven.legacyfabric.net/net/legacyfabric/intermediary/{VERSION}/intermediary-{VERSION}.jar"
LOADER_URL = f"https://maven.fabricmc.net/net/fabricmc/fabric-loader/{LOADER_VERSION}/fabric-loader-{LOADER_VERSION}.jar"

# LWJGL ships as its own pair of jars on the classpath, backed by the WebGL
# reimplementation in natives/, so it is kept out of the merged libraries jar.
SEPARATE = ("org.lwjgl.lwjgl:lwjgl:", "org.lwjgl.lwjgl:lwjgl_util:")

# 1.6.4 lists two LWJGL versions; the launcher uses the 2.9.0 pair.
SKIP = ("2.9.1-nightly",)


def fetch(url, dest):
    if os.path.exists(dest):
        print(f"  have {os.path.basename(dest)}")
        return dest
    print(f"  get  {os.path.basename(dest)}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    urllib.request.urlretrieve(url, dest)
    return dest


def version_meta():
    with urllib.request.urlopen(MANIFEST_URL) as response:
        manifest = json.load(response)
    entry = next(v for v in manifest["versions"] if v["id"] == VERSION)
    with urllib.request.urlopen(entry["url"]) as response:
        return json.load(response)


def library_urls(meta):
    """The plain (non-native) library artifacts 1.6.4 was published with."""
    for library in meta["libraries"]:
        name = library["name"]
        if any(s in name for s in SKIP) or name.startswith(SEPARATE):
            continue
        artifact = library.get("downloads", {}).get("artifact")
        if artifact:  # entries without one are natives-only platform jars
            yield name, artifact["url"]


def build_libraries(jars, output):
    """Merges the library jars into one, dropping signatures and duplicate entries."""
    seen = set()
    written = 0

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        out.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nCreated-By: WebFabric build\r\n\r\n")
        for jar in jars:
            with zipfile.ZipFile(jar) as source:
                for info in source.infolist():
                    name = info.filename
                    if name.endswith("/") or name.startswith("META-INF/") or name in seen:
                        continue
                    seen.add(name)
                    out.writestr(info, source.read(name))
                    written += 1

    print(f"  merged {len(jars)} jars into {written} entries")


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    work = os.path.join(root, "build")
    os.makedirs(work, exist_ok=True)

    meta = version_meta()

    print("downloading game and libraries:")
    client = fetch(meta["downloads"]["client"]["url"], os.path.join(work, f"client-{VERSION}.jar"))
    libraries = [
        fetch(url, os.path.join(work, "libs", os.path.basename(url)))
        for _, url in library_urls(meta)
    ]

    print("downloading loader stack:")
    intermediary = fetch(INTERMEDIARY_URL, os.path.join(root, f"intermediary-{VERSION}.jar"))
    loader = fetch(LOADER_URL, os.path.join(root, f"fabric-loader-{LOADER_VERSION}.jar"))
    asm = [
        fetch(
            f"https://maven.fabricmc.net/org/ow2/asm/{name}/{ASM_VERSION}/{name}-{ASM_VERSION}.jar",
            os.path.join(root, f"{name}-{ASM_VERSION}.jar"),
        )
        for name in ASM_JARS
    ]

    print("building libraries jar:")
    libraries_jar = os.path.join(root, f"minecraft-{VERSION}-libraries.jar")
    build_libraries(libraries, libraries_jar)

    print("remapping game jar (official -> intermediary):")
    subprocess.run(
        ["javac", "-cp", loader, "-d", work, os.path.join(root, "tools", "RemapGameJar.java")],
        check=True,
    )
    subprocess.run(
        [
            "java",
            "-cp", os.pathsep.join([loader, *asm, work]),
            "RemapGameJar",
            client,
            os.path.join(root, f"minecraft-{VERSION}-intermediary.jar"),
            intermediary,
            libraries_jar,
            os.path.join(root, "lwjgl-2.9.0.jar"),
            os.path.join(root, "lwjgl_util-2.9.0.jar"),
        ],
        check=True,
    )

    shutil.rmtree(work, ignore_errors=True)
    print("done")


if __name__ == "__main__":
    main()
