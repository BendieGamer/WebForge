/**
 * Downloads a file from a url and writes it to the CheerpJ filesystem.
 * @param {string} url
 * @param {string} destPath
 * @param {(downloadedBytes: number, totalBytes: number) => void} [progressCallback]
 * @returns {Promise<void>}
 */
async function downloadFileToCheerpJ(url, destPath, progressCallback) {
  const response = await fetch(url);
  const reader = response.body.getReader();
  const contentLength = +response.headers.get('Content-Length');

  const bytes = new Uint8Array(contentLength);
  progressCallback?.(0, contentLength);

  let pos = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, pos);
    pos += value.length;
    progressCallback?.(pos, contentLength);
  }

  await cheerpOSAddStringFile(destPath, bytes);
}

/**
 * Every jar the classpath is built from, in load order. The Fabric Loader stack comes
 * first, then the mappings, then the game itself and the libraries it was shipped with.
 * The game jar has already been remapped from the official namespace to intermediary
 * ahead of time, so the loader never has to run tiny-remapper in the browser.
 */
const JARS = [
  "fabric-loader-0.18.2.jar",
  "asm-9.10.1.jar",
  "asm-analysis-9.10.1.jar",
  "asm-commons-9.10.1.jar",
  "asm-tree-9.10.1.jar",
  "asm-util-9.10.1.jar",
  "sponge-mixin-0.17.3.jar",
  "intermediary-1.6.4.jar",
  "minecraft-1.6.4-intermediary.jar",
  "minecraft-1.6.4-libraries.jar",
  "lwjgl-2.9.0.jar",
  "lwjgl_util-2.9.0.jar",
];

/**
 * Mods shipped with the launcher. There is no upload button, so this is the whole mod
 * list — add a jar here and next to it in the repo to ship it.
 *
 * WARNING: btwce-3.1.1.jar stops the game from starting. It is bundled here by request,
 * but it is compiled to Java 17 bytecode and declares `java >=17 <=21`, while CheerpJ
 * runs Java 8 below, so Fabric Loader aborts at startup with "Incompatible mods found!"
 * and the game never reaches the menu. Raising JAVA_VERSION to 17 does not help either:
 * CheerpJ's Java 17 throws ArrayIndexOutOfBoundsException inside Fabric's own mod
 * resolver before any mod loads. Delete the line below to get a working client back.
 */
const BUNDLED_MODS = [
  "legacy-fabric-api-1.13.5.jar",
  "btwce-3.1.1.jar",
];

/** The JDK CheerpJ boots. 17 is supported but breaks Fabric's mod resolver — see above. */
const JAVA_VERSION = 8;

const GAME_DIR = "/files/game";
const MODS_DIR = `${GAME_DIR}/mods`;

/**
 * Written on first launch only, so anything changed in-game afterwards sticks. CheerpJ
 * renders through a WebGL translation layer, and 1.6.4 otherwise starts on Far render
 * distance with fancy graphics, which is far more than that layer can keep up with.
 * Unknown keys are skipped by the game, and these are all stock 1.6.4 options.
 */
const DEFAULT_OPTIONS = [
  "renderDistance:2",
  "fancyGraphics:false",
  "viewBobbing:false",
  "clouds:false",
  "particles:2",
  "advancedOpengl:false",
].join("\n") + "\n";

const template = document.createElement('template');
template.innerHTML = `
  <style>
    :host {
      display: inline-block;
      aspect-ratio: 854 / 480;

      background: black;
      color: #eee;
      color-scheme: dark;

      width: 854px;
      height: 480px;
    }

    :host([hidden]) {
      display: none;
    }

    canvas {
      width: inherit;
      height: inherit;
    }

    .display {
      width: 854px;
      height: 480px;
      position: absolute;
      inset: 0;
      visibility: hidden;
    }

    .intro {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
    }

    p {
      max-width: 60ch;
    }

    .disclaimer {
      font-size: 0.8em;
      opacity: 0.5;
    }

    button {
      padding: 0.5em 1em;
      margin: 2em;
    }

    progress {
      width: calc(100% - 2em);
      margin: 1em;
    }

    .label {
      font-size: 0.8em;
      opacity: 0.7;
      text-align: center;
    }

    *:focus {
      outline: none;
    }
  </style>
  <canvas width="854" height="480" tabindex="-1"></canvas>
  <div class="display"></div>
  <div class="intro">
    <button>Play!</button>
  </div>
  <progress style="display: none"></progress>
  <div class="label" style="display: none"></div>
`;

export default class MinecraftClient extends HTMLElement {
  #canvas;
  #progress;
  #label;
  #button;
  #display;
  #intro;
  #isRunning;

  constructor() {
    super();

    const shadowRoot = this.attachShadow({ mode: 'open' });
    shadowRoot.appendChild(template.content.cloneNode(true));

    this.#button = shadowRoot.querySelector('button');
    this.#button.addEventListener('click', () => this.run());

    this.#canvas = shadowRoot.querySelector('canvas');
    this.#canvas.width = 854;
    this.#canvas.height = 480;
    this.#canvas.tabIndex = -1;
    this.#canvas.style.display = 'none';

    this.#progress = shadowRoot.querySelector('progress');
    this.#progress.style.display = 'none';

    this.#label = shadowRoot.querySelector('.label');

    this.#intro = shadowRoot.querySelector('.intro');

    this.#display = shadowRoot.querySelector('.display');
    this.#display.setAttribute('style', 'width:100%;height:100%;position:absolute;top:0;left:0px;visibility:hidden;');
    cheerpjCreateDisplay(-1, -1, this.#display);

    this.#isRunning = false;
  }

  static register() {
    customElements.define('minecraft-client', this);
  }

  /** The classpath handed to both `java.class.path` and `cheerpjRunMain`. */
  static get CLASSPATH() {
    return JARS.map((name) => `/str/${name}`).join(":");
  }

  /** The JDK `cheerpjInit` boots. */
  static get JAVA_VERSION() {
    return JAVA_VERSION;
  }

  /**
   * Tells Fabric Loader where everything lives. `fabric.gameMappingNamespace` is the
   * important one: it marks the game jar as already being in the intermediary namespace,
   * which makes the loader skip its runtime deobfuscation pass entirely.
   */
  static get FABRIC_PROPERTIES() {
    return [
      "fabric.gameJarPath=/str/minecraft-1.6.4-intermediary.jar",
      "fabric.gameMappingNamespace=intermediary",
      "fabric.gameVersion=1.6.4",
      `fabric.modsFolder=${MODS_DIR}`,
      "fabric.side=client",
    ];
  }

  /**
   * Deletes anything in the mods folder that this build does not ship. The folder lives
   * in IndexedDB and outlives the page, so a jar left behind by an older build stays
   * forever — and if it was only half written when the tab was closed, Fabric's mod
   * discovery dies on it with "zip file is empty" before the game can start. With
   * uploads disabled there is nothing else that belongs here, so anything unexpected
   * gets cleared rather than left to brick the launcher with no way out.
   * @param {*} lib A `cheerpjRunLibrary` handle.
   */
  static async pruneMods(lib) {
    const File = await lib.java.io.File;
    const keep = new Set(BUNDLED_MODS);

    try {
      const names = await (await new File(MODS_DIR)).list();
      if (!names) return;

      const count = await names.length;
      for (let i = 0; i < count; i++) {
        const name = await names[i];
        if (keep.has(name)) continue;

        await (await new File(`${MODS_DIR}/${name}`)).delete();
        console.log(`Removed stale mod ${name}`);
      }
    } catch (error) {
      // Not worth failing the launch over; the install below still runs.
      console.warn("Could not prune the mods folder:", error);
    }
  }

  /**
   * Creates the game directory, installs the bundled mods, and seeds the graphics
   * settings the first time round. Mods are refreshed on every launch so they always
   * match this build.
   * @param {*} lib A `cheerpjRunLibrary` handle.
   * @param {(message: string) => void} [onProgress]
   */
  static async installBundledMods(lib, onProgress) {
    const Files = await lib.java.nio.file.Files;
    const Paths = await lib.java.nio.file.Paths;
    const StandardCopyOption = await lib.java.nio.file.StandardCopyOption;
    const File = await lib.java.io.File;

    await Files.createDirectories(await Paths.get(MODS_DIR));
    await MinecraftClient.pruneMods(lib);

    for (const name of BUNDLED_MODS) {
      onProgress?.(`Installing ${name}...`);
      await downloadFileToCheerpJ(new URL(name, import.meta.url).href, `/str/${name}`);

      const source = await Paths.get(`/str/${name}`);
      const target = await Paths.get(`${MODS_DIR}/${name}`);

      await Files.copy(source, target, [StandardCopyOption.REPLACE_EXISTING]);
      console.log(`Installed bundled mod ${name}`);
    }

    // java.io.File is used rather than Files.exists here because it takes no varargs,
    // which keeps the CheerpJ method resolution unambiguous.
    const options = await new File(`${GAME_DIR}/options.txt`);
    if (!(await options.exists())) {
      cheerpOSAddStringFile("/str/options.txt", new TextEncoder().encode(DEFAULT_OPTIONS));
      await Files.copy(
        await Paths.get("/str/options.txt"),
        await Paths.get(`${GAME_DIR}/options.txt`),
        [StandardCopyOption.REPLACE_EXISTING]
      );
      console.log("Seeded default graphics settings");
    }
  }

  /** @returns {Promise<number>} Exit code */
  async run(username = "Player") {
    if (this.#isRunning) {
      throw new Error('Already running');
    }
    this.#isRunning = true;

    this.#intro.style.display = 'none';
    this.#progress.style.display = 'unset';
    this.#label.style.display = 'unset';

    for (let i = 0; i < JARS.length; i++) {
      const name = JARS[i];
      this.#label.innerText = `Downloading ${name} (${i + 1}/${JARS.length})`;

      await downloadFileToCheerpJ(
        new URL(name, import.meta.url).href,
        `/str/${name}`,
        (downloadedBytes, totalBytes) => {
          this.#progress.value = downloadedBytes;
          this.#progress.max = totalBytes;
        }
      );
    }

    this.#label.innerText = "Starting Fabric Loader...";
    this.#progress.style.display = 'none';
    this.#label.style.display = 'none';

    this.#canvas.style.display = 'unset';
    window.lwjglCanvasElement = this.#canvas;

    const exitCode = await cheerpjRunMain(
      "net.fabricmc.loader.impl.launch.knot.KnotClient",
      MinecraftClient.CLASSPATH,
      "--username", username,
      "--session", "0",
      "--version", "1.6.4",
      "--gameDir", GAME_DIR
    );

    this.#canvas.style.display = 'none';
    this.#isRunning = false;

    return exitCode;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this.#isRunning;
  }
}
