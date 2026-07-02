import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFolder,
  TFile,
  Vault,
  Notice,
  Menu,
  Modal,
  Setting,
  PluginSettingTab,
  App,
  Platform,
  normalizePath,
  requestUrl,
  MarkdownRenderer,
  AbstractInputSuggest,
  FuzzySuggestModal,
} from "obsidian";

// ─── Compat shims (getFolderByPath/getFileByPath require v1.5.7) ─────────────

function getFolderByPath(vault: Vault, path: string): TFolder | null {
  const f = vault.getAbstractFileByPath(path);
  return f instanceof TFolder ? f : null;
}

function getFileByPath(vault: Vault, path: string): TFile | null {
  const f = vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VIEW_TYPE_ARENA = "arena-browser";
const ICON_ARENA = "layout-grid";
const CHANNEL_META_FILE = "_channel.md";

/** Replaced at build time when `APIFY_TOKEN` is set in `.env` (see esbuild.config.mjs). */
declare const __APIFY_TOKEN__: string | undefined;
function apifyTokenFromBuild(): string {
  const t = typeof __APIFY_TOKEN__ !== "undefined" ? __APIFY_TOKEN__ : "";
  return typeof t === "string" ? t.trim() : "";
}

const DEFAULT_SETTINGS: ArenaPluginSettings = {
  rootFolder: "arena",
  apifyToken: "",
  assetsFolder: "",
  showAssetsInBrowser: false,
  arenaAccessToken: "",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArenaPluginSettings {
  rootFolder: string;
  apifyToken: string;
  /** Vault path for bookmark cover images. Empty means `<rootFolder>/assets`. */
  assetsFolder: string;
  /** When false, the assets folder is omitted from the channel list (if it appears as a subfolder). */
  showAssetsInBrowser: boolean;
  /** Optional Are.na personal access token. Required for importing private channels. */
  arenaAccessToken: string;
}

interface ChannelInfo {
  name: string;
  path: string;
  folder: TFolder;
  blockCount: number;
  subChannelCount: number;
  lastModified: number;
  previewFiles: TFile[];
}

interface BlockInfo {
  file: TFile;
  type: "image" | "markdown" | "pdf" | "video" | "audio" | "other";
  name: string;
}

// ─── Are.na API types ────────────────────────────────────────────────────────

interface ArenaImageVariant {
  url?: string;
}

interface ArenaBlock {
  id: number;
  class?: string;
  title?: string;
  content?: string;
  description?: string;
  slug?: string;
  image?: {
    original?: ArenaImageVariant;
    display?: ArenaImageVariant;
  };
  source?: { url?: string };
  attachment?: { url?: string };
}

interface ArenaChannel {
  id: number;
  title?: string;
  slug?: string;
  length?: number;
  metadata?: { description?: string };
  user?: { slug?: string };
  contents?: ArenaBlock[];
}

function collectFolderPaths(folder: TFolder): string[] {
  const paths: string[] = [folder.path];
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      paths.push(...collectFolderPaths(child));
    }
  }
  return paths;
}

class FolderPathSuggest extends AbstractInputSuggest<string> {
  private paths: string[];

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.paths = collectFolderPaths(app.vault.getRoot()).sort();
  }

  protected getSuggestions(query: string): string[] {
    const q = query.toLowerCase().trim();
    const list = q
      ? this.paths.filter((p) => p.toLowerCase().contains(q))
      : this.paths;
    return list.slice(0, this.limit || 100);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}

class PickFolderModal extends FuzzySuggestModal<string> {
  private folderPaths: string[];
  private onPick: (path: string) => void;

  constructor(app: App, folderPaths: string[], onPick: (path: string) => void) {
    super(app);
    this.folderPaths = folderPaths;
    this.onPick = onPick;
    this.setTitle("Choose folder");
    this.setPlaceholder("Filter folders…");
  }

  getItems(): string[] {
    return this.folderPaths;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
    this.onPick(item);
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class ArenaPlugin extends Plugin {
  settings: ArenaPluginSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_ARENA, (leaf) => new ArenaView(leaf, this));

    this.addRibbonIcon(ICON_ARENA, "Open arena browser", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open",
      name: "Open view",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "create-channel",
      name: "Create new channel",
      callback: () => this.createChannelDialog(),
    });

    this.addCommand({
      id: "migrate-cover-images",
      name: "Migrate cover images to channel folders",
      callback: () => {
        void this.migrateCoverImagesToChannelFolders();
      },
    });

    this.addSettingTab(new ArenaSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      void this.ensureRootFolder();
    });
  }

  onunload() {}

  async loadSettings() {
    const saved =
      (await this.loadData()) as Partial<ArenaPluginSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Resolved vault path for bookmark cover images and other plugin assets. */
  getAssetsFolderPath(): string {
    const raw = this.settings.assetsFolder?.trim();
    if (raw) return normalizePath(raw);
    return normalizePath(`${this.settings.rootFolder}/assets`);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ARENA)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_ARENA, active: true });
    }
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async ensureRootFolder() {
    const root = normalizePath(this.settings.rootFolder);
    if (!getFolderByPath(this.app.vault, root)) {
      await this.app.vault.createFolder(root);
    }
  }

  createChannelDialog(parentFolder?: TFolder) {
    const modal = new CreateChannelModal(this.app, (name: string) => {
      void this.createChannel(name, parentFolder);
    });
    modal.open();
  }

  async createChannel(
    name: string,
    parentFolder?: TFolder,
  ): Promise<TFolder | null> {
    const parent = parentFolder ? parentFolder.path : this.settings.rootFolder;
    const path = normalizePath(`${parent}/${name}`);
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing) {
      new Notice(`Channel "${name}" already exists here`);
      return null;
    }

    await this.app.vault.createFolder(path);

    const metaPath = normalizePath(`${path}/${CHANNEL_META_FILE}`);
    const metaContent = [
      "---",
      `title: "${name}"`,
      `created: ${new Date().toISOString()}`,
      `description: ""`,
      `tags: []`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n");

    await this.app.vault.create(metaPath, metaContent);
    new Notice(`Channel "${name}" created`);
    this.refreshViews();

    return getFolderByPath(this.app.vault, path);
  }

  importChannelDialog(parentFolder?: TFolder) {
    const modal = new ImportChannelModal(this.app, (url: string) => {
      void this.importArenaChannel(url, parentFolder);
    });
    modal.open();
  }

  async importArenaChannel(url: string, parentFolder?: TFolder): Promise<void> {
    // Parse slug from URL (last non-empty path segment)
    let slug: string;
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length === 0) throw new Error("No path segments");
      slug = parts[parts.length - 1];
    } catch {
      new Notice("Invalid Are.na URL");
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.settings.arenaAccessToken) {
      headers["Authorization"] = `Bearer ${this.settings.arenaAccessToken}`;
    }

    new Notice(`Fetching Are.na channel "${slug}"…`);

    let channelData: ArenaChannel;
    try {
      const res = await requestUrl({
        url: `https://api.are.na/v2/channels/${slug}`,
        headers,
      });
      channelData = res.json as ArenaChannel;
    } catch {
      new Notice(`Import failed: could not fetch channel "${slug}"`);
      return;
    }

    if (!channelData || !channelData.id) {
      new Notice(`Import failed: channel "${slug}" not found`);
      return;
    }

    // Collect all blocks — first page is embedded in channel response
    let allBlocks: ArenaBlock[] = channelData.contents ?? [];
    const total = channelData.length ?? allBlocks.length;
    const perPage = 25;

    if (total > allBlocks.length) {
      // Fetch remaining pages
      const fetchedFirst = allBlocks.length;
      const remainingPages = Math.ceil((total - fetchedFirst) / perPage);
      for (let page = 2; page <= remainingPages + 1; page++) {
        try {
          const res = await requestUrl({
            url: `https://api.are.na/v2/channels/${slug}/contents?page=${page}&per=${perPage}`,
            headers,
          });
          const pageData = res.json as { contents?: ArenaBlock[] };
          if (pageData.contents)
            allBlocks = allBlocks.concat(pageData.contents);
        } catch {
          new Notice(`Warning: failed to fetch page ${page} of "${slug}"`);
          break;
        }
      }
    }

    // Create the channel folder
    const channelTitle = channelData.title ?? slug;
    const folderName = channelTitle.replace(/[/\\:*?"<>|]/g, "-").trim() || slug;
    const parent = parentFolder ? parentFolder.path : this.settings.rootFolder;
    const folderPath = normalizePath(`${parent}/${folderName}`);

    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing) {
      new Notice(`Channel "${folderName}" already exists here`);
      return;
    }

    await this.app.vault.createFolder(folderPath);

    const metaLines = [
      "---",
      `title: "${channelTitle.replace(/"/g, '\\"')}"`,
      `created: ${new Date().toISOString()}`,
      `description: "${(channelData.metadata?.description ?? "").replace(/"/g, '\\"')}"`,
      `tags: []`,
      `arena_id: ${channelData.id}`,
      `arena_slug: "${channelData.slug}"`,
      `arena_url: "https://www.are.na/${channelData.user?.slug ?? ""}/${channelData.slug}"`,
      "---",
      "",
      `# ${channelTitle}`,
      "",
    ];
    await this.app.vault.create(
      normalizePath(`${folderPath}/${CHANNEL_META_FILE}`),
      metaLines.join("\n"),
    );

    // Process blocks
    const usedNames = new Set<string>();

    const deduplicateName = (base: string, ext: string): string => {
      let candidate = `${base}${ext}`;
      let counter = 1;
      while (usedNames.has(candidate)) {
        candidate = `${base}-${counter}${ext}`;
        counter++;
      }
      usedNames.add(candidate);
      return candidate;
    };

    for (let i = 0; i < allBlocks.length; i++) {
      const block = allBlocks[i];
      if (i > 0 && i % 5 === 0) {
        new Notice(`Importing block ${i + 1} / ${allBlocks.length}…`);
      }
      try {
        await this.importArenaBlock(block, folderPath, deduplicateName);
      } catch {
        // Per-block errors don't abort the import
      }
    }

    this.refreshViews();
    new Notice(`Imported "${channelTitle}" (${allBlocks.length} blocks)`);
  }

  private async importArenaBlock(
    block: ArenaBlock,
    folderPath: string,
    deduplicateName: (base: string, ext: string) => string,
  ): Promise<void> {
    const safeBase =
      (block.title ?? `block-${block.id}`)
        .replace(/[/\\:*?"<>|]/g, "-")
        .trim() || `block-${block.id}`;

    switch (block.class) {
      case "Image": {
        const originalUrl = block.image?.original?.url;
        const displayUrl = block.image?.display?.url;
        const imageUrl = originalUrl ?? displayUrl;
        if (imageUrl) {
          const ext = imageUrl.split("?")[0].match(/\.\w+$/)?.[0] ?? ".jpg";
          const fileName = deduplicateName(safeBase, ext);
          try {
            const imgRes = await requestUrl({ url: imageUrl, method: "GET" });
            await this.app.vault.createBinary(
              normalizePath(`${folderPath}/${fileName}`),
              imgRes.arrayBuffer,
            );
            return;
          } catch {
            // Fall through: try display URL if original failed, then save as note
          }

          // If original failed and display is different, try display URL
          let fallbackCoverPath = "";
          if (displayUrl && displayUrl !== imageUrl) {
            try {
              const coverExt =
                displayUrl.split("?")[0].match(/\.\w+$/)?.[0] ?? ".jpg";
              const coverFileName = deduplicateName(
                `${safeBase}-cover`,
                coverExt,
              );
              const coverRes = await requestUrl({
                url: displayUrl,
                method: "GET",
              });
              const coverPath = normalizePath(
                `${folderPath}/${coverFileName}`,
              );
              await this.app.vault.createBinary(
                coverPath,
                coverRes.arrayBuffer,
              );
              fallbackCoverPath = coverPath;
            } catch {
              // No cover available
            }
          }

          // Fallback: save as markdown note with image link
          const fallbackName = deduplicateName(safeBase, ".md");
          const lines = [
            "---",
            `type: image`,
            `arena_id: ${block.id}`,
            `url: "${imageUrl}"`,
            `cover_image: "${fallbackCoverPath}"`,
            "---",
            "",
            `![${safeBase}](${imageUrl})`,
            "",
          ];
          await this.app.vault.create(
            normalizePath(`${folderPath}/${fallbackName}`),
            lines.join("\n"),
          );
        }
        break;
      }

      case "Text": {
        const fileName = deduplicateName(safeBase, ".md");
        const lines = [
          "---",
          `type: text`,
          `arena_id: ${block.id}`,
          "---",
          "",
          block.content ?? "",
          "",
        ];
        await this.app.vault.create(
          normalizePath(`${folderPath}/${fileName}`),
          lines.join("\n"),
        );
        break;
      }

      case "Link":
      case "Media": {
        const fileName = deduplicateName(safeBase, ".md");
        const sourceUrl = block.source?.url ?? "";

        // Download the Are.na-provided thumbnail/snapshot so the grid can show it
        const thumbUrl =
          block.image?.display?.url ?? block.image?.original?.url;
        let coverImagePath = "";
        if (thumbUrl) {
          try {
            const coverExt =
              thumbUrl.split("?")[0].match(/\.\w+$/)?.[0] ?? ".jpg";
            const coverFileName = deduplicateName(`${safeBase}-cover`, coverExt);
            const coverRes = await requestUrl({ url: thumbUrl, method: "GET" });
            const coverPath = normalizePath(
              `${folderPath}/${coverFileName}`,
            );
            await this.app.vault.createBinary(coverPath, coverRes.arrayBuffer);
            coverImagePath = coverPath;
          } catch {
            // Continue without cover image
          }
        }

        const lines = [
          "---",
          `type: ${block.class.toLowerCase()}`,
          `arena_id: ${block.id}`,
          `url: "${sourceUrl}"`,
          `title: "${(block.title ?? "").replace(/"/g, '\\"')}"`,
          `description: "${(block.description ?? "").replace(/"/g, '\\"')}"`,
          `cover_image: "${coverImagePath}"`,
          "---",
          "",
          `# [${block.title ?? safeBase}](${sourceUrl})`,
          "",
        ];
        if (block.description) lines.push(`> ${block.description}`, "");
        await this.app.vault.create(
          normalizePath(`${folderPath}/${fileName}`),
          lines.join("\n"),
        );
        break;
      }

      case "Attachment": {
        const fileName = deduplicateName(safeBase, ".md");
        const attachUrl = block.attachment?.url ?? "";
        const lines = [
          "---",
          `type: attachment`,
          `arena_id: ${block.id}`,
          `attachment_url: "${attachUrl}"`,
          "---",
          "",
          `# ${block.title ?? safeBase}`,
          "",
          attachUrl ? `[Download](${attachUrl})` : "",
          "",
        ];
        await this.app.vault.create(
          normalizePath(`${folderPath}/${fileName}`),
          lines.join("\n"),
        );
        break;
      }

      case "Channel": {
        const fileName = deduplicateName(safeBase, ".md");
        const connectedSlug = block.slug ?? "";
        const connectedTitle = block.title ?? connectedSlug;
        const lines = [
          "---",
          `type: channel`,
          `arena_id: ${block.id}`,
          `arena_slug: "${connectedSlug}"`,
          `arena_url: "https://www.are.na/${connectedSlug}"`,
          "---",
          "",
          `# ${connectedTitle}`,
          "",
          `Connected channel: [${connectedTitle}](https://www.are.na/${connectedSlug})`,
          "",
        ];
        await this.app.vault.create(
          normalizePath(`${folderPath}/${fileName}`),
          lines.join("\n"),
        );
        break;
      }

      default: {
        const fileName = deduplicateName(safeBase, ".md");
        const lines = [
          "---",
          `type: unknown`,
          `arena_id: ${block.id}`,
          `arena_class: "${block.class ?? ""}"`,
          "---",
          "",
          `\`\`\`json`,
          JSON.stringify(block, null, 2),
          `\`\`\``,
          "",
        ];
        await this.app.vault.create(
          normalizePath(`${folderPath}/${fileName}`),
          lines.join("\n"),
        );
        break;
      }
    }
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_ARENA).forEach((leaf) => {
      if (leaf.view instanceof ArenaView) {
        leaf.view.render();
      }
    });
  }

  async migrateCoverImagesToChannelFolders() {
    const root = normalizePath(this.settings.rootFolder);
    const mdFiles = this.app.vault
      .getFiles()
      .filter(
        (f) =>
          f.extension === "md" &&
          (f.path === `${root}/${f.name}` || f.path.startsWith(`${root}/`)) &&
          f.name !== CHANNEL_META_FILE,
      );

    let moved = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of mdFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const coverPath = cache?.frontmatter?.cover_image as string | undefined;
      if (!coverPath) continue;

      const coverFile = getFileByPath(this.app.vault, coverPath);
      if (!coverFile) continue;

      if (coverFile.parent?.path === file.parent?.path) {
        skipped++;
        continue;
      }

      const targetFolder = file.parent!.path;
      let newCoverPath = normalizePath(`${targetFolder}/${coverFile.name}`);

      // Avoid collision with an existing file that isn't the same file
      let counter = 1;
      while (
        this.app.vault.getAbstractFileByPath(newCoverPath) &&
        getFileByPath(this.app.vault, newCoverPath) !== coverFile
      ) {
        const ext = coverFile.extension ? `.${coverFile.extension}` : "";
        const base = coverFile.basename;
        newCoverPath = normalizePath(
          `${targetFolder}/${base}-${counter}${ext}`,
        );
        counter++;
      }

      try {
        await this.app.vault.rename(coverFile, newCoverPath);

        // Update the cover_image path in the note's frontmatter
        const raw = await this.app.vault.read(file);
        const updated = raw.replace(
          /^(cover_image:\s*")[^"]*(")/m,
          `$1${newCoverPath}$2`,
        );
        if (updated !== raw) {
          await this.app.vault.modify(file, updated);
        }

        moved++;
      } catch (err) {
        console.error("Arena: failed to migrate cover image", coverPath, err);
        failed++;
      }
    }

    const parts: string[] = [];
    if (moved > 0)
      parts.push(`Moved ${moved} cover image${moved !== 1 ? "s" : ""}`);
    if (skipped > 0) parts.push(`${skipped} already in place`);
    if (failed > 0) parts.push(`${failed} failed`);
    new Notice(parts.length ? parts.join(", ") : "No cover images to migrate");
    this.refreshViews();
  }

  /**
   * Scan all Are.na-imported blocks in the root folder that are missing a cover
   * image and attempt to fetch one from the Are.na API using each block's
   * `arena_id`. Works for `link`, `media`, and `image` (fallback-note) blocks.
   *
   * Blocks without an `arena_id` (manually added notes) are skipped — there is
   * no reliable way to map them to an Are.na block. The Are.na `/v2/blocks/:id`
   * endpoint returns the original block data including any snapshot/thumbnail
   * image that Are.na captured, so no URL search is needed.
   */
  async refreshMissingArenaCovers(): Promise<void> {
    const root = normalizePath(this.settings.rootFolder);

    // Collect all candidate .md files
    const candidates = this.app.vault.getFiles().filter((f) => {
      if (f.extension !== "md") return false;
      if (f.name === CHANNEL_META_FILE) return false;
      if (!f.path.startsWith(`${root}/`)) return false;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) return false;
      const type = fm.type as string | undefined;
      if (!["link", "media", "image"].includes(type ?? "")) return false;
      const arenaId = fm.arena_id as number | string | undefined;
      if (!arenaId) return false;
      // Consider "missing" when: field absent, empty string, or file gone
      const coverPath = fm.cover_image as string | undefined;
      if (coverPath) {
        const exists = getFileByPath(this.app.vault, coverPath);
        if (exists) return false; // already has a valid cover
      }
      return true;
    });

    if (candidates.length === 0) {
      new Notice("No Are.na blocks need a cover image refresh.");
      return;
    }

    new Notice(
      `Refreshing covers for ${candidates.length} block${candidates.length !== 1 ? "s" : ""}…`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.settings.arenaAccessToken) {
      headers["Authorization"] = `Bearer ${this.settings.arenaAccessToken}`;
    }

    let fetched = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i];
      if (i > 0 && i % 10 === 0) {
        new Notice(`Refreshing covers… ${i} / ${candidates.length}`);
      }

      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const arenaId = fm?.arena_id as number | string | undefined;
      if (!arenaId) continue;

      try {
        const res = await requestUrl({
          url: `https://api.are.na/v2/blocks/${arenaId}`,
          headers,
        });
        const block = res.json as ArenaBlock;

        const thumbUrl =
          block.image?.display?.url ?? block.image?.original?.url;
        if (!thumbUrl) {
          skipped++;
          continue;
        }

        // Download the image next to the note
        const coverExt =
          thumbUrl.split("?")[0].match(/\.\w+$/)?.[0] ?? ".jpg";
        const baseName = file.basename;
        let coverPath = normalizePath(
          `${file.parent!.path}/${baseName}-cover${coverExt}`,
        );
        // Avoid overwriting an unrelated file
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(coverPath)) {
          coverPath = normalizePath(
            `${file.parent!.path}/${baseName}-cover-${counter}${coverExt}`,
          );
          counter++;
        }

        const imgRes = await requestUrl({ url: thumbUrl, method: "GET" });
        await this.app.vault.createBinary(coverPath, imgRes.arrayBuffer);

        // Update or insert cover_image in the note's frontmatter
        const raw = await this.app.vault.read(file);
        let updated: string;
        if (/^cover_image:/m.test(raw)) {
          updated = raw.replace(
            /^cover_image:.*$/m,
            `cover_image: "${coverPath}"`,
          );
        } else {
          // Insert before the closing --- of the frontmatter block
          updated = raw.replace(
            /^(---\n[\s\S]*?)(---)/m,
            `$1cover_image: "${coverPath}"\n$2`,
          );
        }
        if (updated !== raw) {
          await this.app.vault.modify(file, updated);
        }

        fetched++;
      } catch {
        failed++;
      }
    }

    const parts: string[] = [];
    if (fetched > 0)
      parts.push(`Added ${fetched} cover image${fetched !== 1 ? "s" : ""}`);
    if (skipped > 0)
      parts.push(
        `${skipped} block${skipped !== 1 ? "s" : ""} had no image in Are.na`,
      );
    if (failed > 0)
      parts.push(`${failed} failed`);

    new Notice(
      parts.length ? parts.join(", ") : "No covers updated.",
      6000,
    );
    this.refreshViews();
  }
}

// ─── Arena View ──────────────────────────────────────────────────────────────

interface PendingBlock {
  id: string;
  label: string;
  channel: string;
}

class ArenaView extends ItemView {
  plugin: ArenaPlugin;
  currentChannel: TFolder | null = null;
  navigationStack: TFolder[] = [];
  pendingBlocks: PendingBlock[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: ArenaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_ARENA;
  }

  getDisplayText(): string {
    if (this.currentChannel) {
      return `Arena / ${this.currentChannel.name}`;
    }
    return "Arena";
  }

  getIcon(): string {
    return ICON_ARENA;
  }

  async onOpen() {
    await super.onOpen();
    this.render();

    let refreshTimer: number | null = null;
    const debouncedRender = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => this.render(), 200);
    };

    this.registerEvent(this.app.vault.on("create", debouncedRender));
    this.registerEvent(this.app.vault.on("delete", debouncedRender));
    this.registerEvent(this.app.vault.on("rename", debouncedRender));
  }

  async onClose() {
    await super.onClose();
    this.contentEl.empty();
  }

  onResize() {
    this.render();
  }

  // ── Touch helpers ──────────────────────────────────────────────────────────

  addLongPress(el: HTMLElement, callback: (e: TouchEvent) => void, ms = 500) {
    let timer: number | null = null;
    let moved = false;

    el.addEventListener(
      "touchstart",
      (e) => {
        moved = false;
        timer = window.setTimeout(() => {
          if (!moved) {
            e.preventDefault();
            callback(e);
          }
        }, ms);
      },
      { passive: false },
    );

    el.addEventListener("touchmove", () => {
      moved = true;
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
    });

    el.addEventListener("touchend", () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
    });

    el.addEventListener("touchcancel", () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
    });
  }

  showContextMenuAtPoint(x: number, y: number, menu: Menu) {
    type MenuWithPosition = Menu & {
      showAtPosition?: (pos: { x: number; y: number }) => void;
    };
    (menu as MenuWithPosition).showAtPosition?.({ x, y });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("arena-container");

    if (this.currentChannel) {
      this.renderChannel(container, this.currentChannel);
    } else {
      this.renderChannelGrid(container);
    }

    type LeafWithHeader = WorkspaceLeaf & { updateHeader?: () => void };
    (this.leaf as LeafWithHeader).updateHeader?.();
  }

  // ── Breadcrumb ─────────────────────────────────────────────────────────────

  renderBreadcrumb(container: HTMLElement) {
    const breadcrumb = container.createDiv({ cls: "arena-breadcrumb" });

    const rootLink = breadcrumb.createSpan({
      text: "Arena",
      cls: "arena-breadcrumb-link",
    });
    rootLink.addEventListener("click", () => {
      this.currentChannel = null;
      this.navigationStack = [];
      this.render();
    });

    for (let i = 0; i < this.navigationStack.length; i++) {
      breadcrumb.createSpan({
        text: " / ",
        cls: "arena-breadcrumb-sep",
      });

      const folder = this.navigationStack[i];
      const link = breadcrumb.createSpan({
        text: folder.name,
        cls: "arena-breadcrumb-link",
      });
      link.addEventListener("click", () => {
        this.navigationStack = this.navigationStack.slice(0, i + 1);
        this.currentChannel = folder;
        this.render();
      });
    }

    if (this.currentChannel) {
      const isInStack =
        this.navigationStack.length > 0 &&
        this.navigationStack[this.navigationStack.length - 1].path ===
          this.currentChannel.path;

      if (!isInStack) {
        breadcrumb.createSpan({
          text: " / ",
          cls: "arena-breadcrumb-sep",
        });
        breadcrumb.createSpan({
          text: this.currentChannel.name,
          cls: "arena-breadcrumb-current",
        });
      }
    }
  }

  // ── Channel Grid (home view) ───────────────────────────────────────────────

  renderChannelGrid(container: HTMLElement) {
    const channels = this.getChannels();

    const header = container.createDiv({ cls: "arena-header" });
    header.createEl("h1", { text: "Arena", cls: "arena-title" });

    const actions = header.createDiv({ cls: "arena-header-actions" });
    const newBtn = actions.createEl("button", {
      text: "New channel +",
      cls: "arena-btn",
    });
    newBtn.addEventListener("click", () => {
      this.plugin.createChannelDialog();
    });
    const importBtn = actions.createEl("button", {
      text: "Import +",
      cls: "arena-btn",
    });
    importBtn.addEventListener("click", () => {
      this.plugin.importChannelDialog();
    });

    const grid = container.createDiv({ cls: "arena-grid" });

    if (channels.length === 0) {
      const empty = grid.createDiv({ cls: "arena-empty" });
      empty.createEl("p", {
        text: "No channels yet. Create one to get started.",
      });
      return;
    }

    for (const channel of channels) {
      this.renderParentChannelCard(grid, channel);
    }
  }

  renderParentChannelCard(parent: HTMLElement, channel: ChannelInfo) {
    // Outer bordered rectangle that wraps the parent + sub-channels
    const wrapper = parent.createDiv({ cls: "arena-parent-row" });

    // Compute how many columns fit so preview items never wrap to a new line.
    // The parent card occupies one slot; remaining slots hold preview items.
    const isMobile = Platform.isMobile;
    const rowWidth = wrapper.clientWidth || parent.clientWidth || 800;
    const innerPadding = isMobile ? 24 : 32; // padding: 12px or 16px per side
    const minCard = isMobile ? 160 : 220;
    const gap = isMobile ? 10 : 16;
    const availableWidth = rowWidth - innerPadding;
    const cols = Math.max(
      1,
      Math.floor((availableWidth + gap) / (minCard + gap)),
    );
    const PREVIEW_COUNT = Math.max(0, cols - 1);

    const subChannels = this.getSubChannels(channel.folder).slice(
      0,
      PREVIEW_COUNT,
    );

    // Inner row: parent card on left, items on right
    const innerRow = wrapper.createDiv({ cls: "arena-parent-inner" });
    innerRow.style.setProperty(
      "--arena-parent-cols",
      String(PREVIEW_COUNT + 1),
    );
    innerRow.style.setProperty(
      "--arena-parent-preview-cols",
      String(PREVIEW_COUNT),
    );

    // Parent channel square (left side, fixed size)
    const parentCard = innerRow.createDiv({ cls: "arena-parent-card" });

    parentCard.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showChannelContextMenu(e, channel);
    });

    if (Platform.isMobile) {
      this.addLongPress(parentCard, (e) => {
        const touch = e.touches[0] || e.changedTouches[0];
        if (touch) {
          const menu = this.buildChannelContextMenu(channel);
          this.showContextMenuAtPoint(touch.clientX, touch.clientY, menu);
        }
      });
    }

    const parentInfo = parentCard.createDiv({ cls: "arena-parent-info" });
    parentInfo.createEl("h3", { text: channel.name, cls: "arena-card-title" });

    const parentMeta = parentInfo.createDiv({ cls: "arena-parent-meta" });
    parentMeta.createSpan({
      text: `${channel.blockCount} block${channel.blockCount !== 1 ? "s" : ""}`,
      cls: "arena-card-meta",
    });
    parentMeta.createSpan({
      text: this.timeAgo(channel.lastModified),
      cls: "arena-card-meta",
    });

    parentCard.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openChannel(channel.folder);
    });

    // Always render exactly PREVIEW_COUNT slots to the right; fill with
    // sub-channels, then blocks, then blank placeholders.
    const subGrid = innerRow.createDiv({ cls: "arena-parent-sub-grid" });

    if (subChannels.length > 0) {
      for (const sub of subChannels) {
        const subCard = subGrid.createDiv({ cls: "arena-sub-channel-card" });

        const subInfo = subCard.createDiv({ cls: "arena-sub-channel-info" });
        subInfo.createEl("h3", {
          text: sub.name,
          cls: "arena-sub-channel-title",
        });

        const subMeta = subInfo.createDiv({ cls: "arena-sub-meta" });
        subMeta.createSpan({
          text: `${sub.blockCount} block${sub.blockCount !== 1 ? "s" : ""}`,
          cls: "arena-card-meta",
        });
        subMeta.createSpan({
          text: this.timeAgo(sub.lastModified),
          cls: "arena-card-meta",
        });

        subCard.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openChannel(sub.folder);
        });

        subCard.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showChannelContextMenu(e, sub);
        });

        if (Platform.isMobile) {
          this.addLongPress(subCard, (e) => {
            const touch = e.touches[0] || e.changedTouches[0];
            if (touch) {
              const menu = this.buildChannelContextMenu(sub);
              this.showContextMenuAtPoint(touch.clientX, touch.clientY, menu);
            }
          });
        }
      }

      for (let i = subChannels.length; i < PREVIEW_COUNT; i++) {
        subGrid.createDiv({ cls: "arena-sub-channel-empty" });
      }
    } else {
      const blocks = this.getBlocks(channel.folder).slice(0, PREVIEW_COUNT);

      for (const block of blocks) {
        this.renderBlockCard(subGrid, block);
      }

      for (let i = blocks.length; i < PREVIEW_COUNT; i++) {
        subGrid.createDiv({ cls: "arena-sub-channel-empty" });
      }
    }
  }

  buildChannelContextMenu(channel: ChannelInfo): Menu {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("Open channel")
        .setIcon("folder-open")
        .onClick(() => this.openChannel(channel.folder)),
    );

    menu.addItem((item) =>
      item
        .setTitle("Create sub-channel")
        .setIcon("folder-plus")
        .onClick(() => this.plugin.createChannelDialog(channel.folder)),
    );

    type AppWithInternals = App & {
      internalPlugins?: {
        plugins?: Record<
          string,
          { instance?: { revealInFolder?: (f: TFolder) => void } }
        >;
      };
    };
    const fileExplorer = (this.app as AppWithInternals).internalPlugins
      ?.plugins?.["file-explorer"]?.instance;
    if (fileExplorer) {
      menu.addItem((item) =>
        item
          .setTitle("Reveal in file explorer")
          .setIcon("folder-search")
          .onClick(() => {
            const folder = getFolderByPath(this.app.vault, channel.path);
            if (folder) fileExplorer.revealInFolder?.(folder);
          }),
      );
    }

    menu.addItem((item) =>
      item
        .setTitle("Delete channel")
        .setIcon("trash")
        .onClick(() => {
          new ConfirmModal(
            this.app,
            `Delete channel "${channel.name}" and all its contents?`,
            () => {
              void this.app.fileManager
                .trashFile(channel.folder)
                .then(() => this.render());
            },
          ).open();
        }),
    );

    return menu;
  }

  showChannelContextMenu(e: MouseEvent, channel: ChannelInfo) {
    const menu = this.buildChannelContextMenu(channel);
    menu.showAtMouseEvent(e);
  }

  buildBlockContextMenu(block: BlockInfo): Menu {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("Open file")
        .setIcon("file")
        .onClick(() => {
          void this.app.workspace.openLinkText(block.file.path, "", false);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open in new tab")
        .setIcon("file-plus")
        .onClick(() => {
          void this.app.workspace.openLinkText(block.file.path, "", "tab");
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Remove from channel")
        .setIcon("trash")
        .onClick(() => {
          void this.app.fileManager
            .trashFile(block.file)
            .then(() => this.render());
        }),
    );

    return menu;
  }

  renderChannelCard(parent: HTMLElement, channel: ChannelInfo) {
    const card = parent.createDiv({ cls: "arena-card arena-channel-card" });

    const info = card.createDiv({ cls: "arena-card-info" });
    info.createEl("h3", { text: channel.name, cls: "arena-card-title" });

    const metaLine = info.createDiv({ cls: "arena-card-meta-row" });
    metaLine.createSpan({
      text: `${channel.blockCount} blocks`,
      cls: "arena-card-meta",
    });
    if (channel.subChannelCount > 0) {
      metaLine.createSpan({
        text: ` · ${channel.subChannelCount} sub-channels`,
        cls: "arena-card-meta",
      });
    }
    info.createSpan({
      text: this.timeAgo(channel.lastModified),
      cls: "arena-card-meta",
    });

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openChannel(channel.folder);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showChannelContextMenu(e, channel);
    });

    if (Platform.isMobile) {
      this.addLongPress(card, (e) => {
        const touch = e.touches[0] || e.changedTouches[0];
        if (touch) {
          const menu = this.buildChannelContextMenu(channel);
          this.showContextMenuAtPoint(touch.clientX, touch.clientY, menu);
        }
      });
    }

    this.setupDropZone(card, channel.folder);
  }

  // ── Channel View (blocks + sub-channels) ───────────────────────────────────

  renderChannel(container: HTMLElement, folder: TFolder) {
    const blocks = this.getBlocks(folder);
    const subChannels = this.getSubChannels(folder);

    this.renderBreadcrumb(container);

    const header = container.createDiv({ cls: "arena-header" });
    const titleRow = header.createDiv({ cls: "arena-title-row" });
    titleRow.createEl("h1", { text: folder.name, cls: "arena-title" });

    const countParts: string[] = [];
    if (blocks.length > 0) countParts.push(`${blocks.length} blocks`);
    if (subChannels.length > 0)
      countParts.push(`${subChannels.length} sub-channels`);
    if (countParts.length > 0) {
      titleRow.createSpan({
        text: countParts.join(" · "),
        cls: "arena-channel-count",
      });
    }

    const actions = header.createDiv({ cls: "arena-header-actions" });
    const newSubBtn = actions.createEl("button", {
      text: "New channel +",
      cls: "arena-btn arena-btn-primary",
    });
    newSubBtn.addEventListener("click", () => {
      this.plugin.createChannelDialog(folder);
    });
    const importSubBtn = actions.createEl("button", {
      text: "Import +",
      cls: "arena-btn",
    });
    importSubBtn.addEventListener("click", () => {
      this.plugin.importChannelDialog(folder);
    });

    // Sub-channels
    if (subChannels.length > 0) {
      const subSection = container.createDiv({ cls: "arena-section" });
      subSection.createEl("h2", {
        text: "Sub-channels",
        cls: "arena-section-title",
      });

      const subGrid = subSection.createDiv({ cls: "arena-grid" });

      for (const sub of subChannels) {
        this.renderChannelCard(subGrid, sub);
      }
    }

    // Blocks grid — drop zone is always the first cell
    const blockSection = container.createDiv({ cls: "arena-section" });
    if (subChannels.length > 0) {
      blockSection.createEl("h2", {
        text: "Blocks",
        cls: "arena-section-title",
      });
    }

    const grid = blockSection.createDiv({
      cls: "arena-grid arena-block-grid",
    });

    // Drop zone pinned to first position
    const dropZone = grid.createDiv({
      cls: "arena-drop-zone arena-block-card",
    });

    const fileInput = dropZone.createEl("input", { type: "file" });
    fileInput.multiple = true;
    fileInput.addClass("arena-file-input-hidden");
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length > 0) {
        void this.importFileList(fileInput.files, folder).then(() => {
          fileInput.value = "";
        });
      }
    });

    // Placeholder state
    const placeholder = dropZone.createDiv({
      cls: "arena-drop-zone-placeholder",
    });
    const placeholderText = placeholder.createEl("p", {
      cls: "arena-drop-zone-hint",
    });
    let chooseLink: HTMLElement;
    if (Platform.isMobile) {
      chooseLink = placeholderText.createSpan({
        text: "Choose files",
        cls: "arena-drop-zone-choose",
      });
      placeholderText.appendText(" or tap to type a URL or text");
    } else {
      placeholderText.appendText("Drop or ");
      chooseLink = placeholderText.createSpan({
        text: "choose",
        cls: "arena-drop-zone-choose",
      });
      placeholderText.appendText(
        " files, paste an image or URL (image, video, or link) or type text here",
      );
    }

    chooseLink.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      fileInput.click();
    });

    // Editing state
    const inputWrapper = dropZone.createDiv({
      cls: "arena-drop-zone-input-wrapper",
    });
    const textarea = inputWrapper.createEl("textarea", {
      cls: "arena-drop-zone-textarea",
    });
    const hintBar = inputWrapper.createDiv({ cls: "arena-drop-zone-hint-bar" });
    const defaultHint = Platform.isMobile
      ? "Enter to submit"
      : "Shift + Enter for line break";
    hintBar.createSpan({ text: defaultHint });

    const activateEditing = () => {
      dropZone.addClass("arena-drop-zone-editing");
      textarea.focus();
    };

    const deactivateEditing = () => {
      if (!textarea.value.trim()) {
        dropZone.removeClass("arena-drop-zone-editing");
      }
    };

    dropZone.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".arena-drop-zone-choose")) return;
      if (target.closest("input")) return;
      e.stopPropagation();
      activateEditing();
    });

    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = textarea.value.trim();
        if (!text) return;

        textarea.value = "";
        dropZone.removeClass("arena-drop-zone-editing");

        if (/^https?:\/\//.test(text)) {
          void this.enqueueUrlBookmark(text, folder);
        } else {
          void this.createTextBlock(text, folder).then(() => this.render());
        }
      }
    });

    textarea.addEventListener("paste", (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const clipData = e.clipboardData;
      const items = Array.from(clipData.items);
      if (items.some((item) => item.type.startsWith("image/"))) {
        e.preventDefault();
        textarea.value = "";
        dropZone.removeClass("arena-drop-zone-editing");
        void this.saveClipboardImage(clipData, folder);
        return;
      }
      const text = clipData.getData("text/plain")?.trim();
      if (text && /^https?:\/\/\S+$/.test(text)) {
        e.preventDefault();
        textarea.value = "";
        dropZone.removeClass("arena-drop-zone-editing");
        void this.enqueueUrlBookmark(text, folder);
      }
    });

    textarea.addEventListener("blur", () => {
      deactivateEditing();
    });

    this.setupDropZone(dropZone, folder);

    for (const pending of this.pendingBlocks.filter(
      (p) => p.channel === folder.path,
    )) {
      this.renderPendingBlockCard(grid, pending);
    }

    for (const block of blocks) {
      this.renderBlockCard(grid, block);
    }
  }

  renderPendingBlockCard(parent: HTMLElement, pending: PendingBlock) {
    const card = parent.createDiv({
      cls: "arena-card arena-block-card arena-block-pending",
    });
    const preview = card.createDiv({ cls: "arena-block-preview" });
    const spinner = preview.createDiv({ cls: "arena-pending-spinner" });
    for (let i = 0; i < 8; i++) {
      spinner.createSpan();
    }
    const label = card.createDiv({ cls: "arena-block-label" });
    label.createSpan({
      text: pending.label,
      cls: "arena-block-name arena-pending-label",
    });
  }

  renderBlockCard(parent: HTMLElement, block: BlockInfo) {
    const card = parent.createDiv({ cls: "arena-card arena-block-card" });
    const preview = card.createDiv({ cls: "arena-block-preview" });

    switch (block.type) {
      case "image": {
        const img = preview.createEl("img", { cls: "arena-block-image" });
        img.src = this.app.vault.getResourcePath(block.file);
        img.alt = block.name;
        img.loading = "lazy";
        break;
      }
      case "markdown": {
        const fm = this.app.metadataCache.getFileCache(block.file)?.frontmatter;
        const coverPath = fm?.cover_image as string | undefined;
        const sourcePlatform = fm?.source_platform as string | undefined;
        if (coverPath) {
          const coverFile = getFileByPath(this.app.vault, coverPath);
          if (coverFile) {
            const img = preview.createEl("img", { cls: "arena-block-image" });
            img.src = this.app.vault.getResourcePath(coverFile);
            img.alt = block.name;
            img.loading = "lazy";
            if (sourcePlatform) {
              preview.createSpan({
                text: sourcePlatform,
                cls: "arena-source-badge",
              });
            }
            break;
          }
        }
        preview.addClass("arena-block-text");
        void (async () => {
          const content = await this.app.vault.cachedRead(block.file);
          const stripped = content.replace(/^---[\s\S]*?---\n?/, "");
          const lines = stripped.trim().split("\n").slice(0, 8).join("\n");
          const excerptEl = preview.createDiv({ cls: "arena-block-excerpt" });
          await MarkdownRenderer.render(
            this.app,
            lines,
            excerptEl,
            block.file.path,
            this,
          );
        })();
        break;
      }
      case "pdf":
        preview.addClass("arena-block-file");
        preview.createSpan({ text: "PDF", cls: "arena-file-icon" });
        break;
      case "video":
        preview.addClass("arena-block-file");
        preview.createSpan({ text: "VIDEO", cls: "arena-file-icon" });
        break;
      case "audio":
        preview.addClass("arena-block-file");
        preview.createSpan({ text: "AUDIO", cls: "arena-file-icon" });
        break;
      default:
        preview.addClass("arena-block-file");
        preview.createSpan({
          text: block.file.extension.toUpperCase(),
          cls: "arena-file-icon",
        });
    }

    // Add Source button if block has a URL in frontmatter
    const cache = this.app.metadataCache.getFileCache(block.file);
    const urlVal: unknown = cache?.frontmatter?.url;
    const url = typeof urlVal === "string" ? urlVal : undefined;
    if (url) {
      const sourceBtn = card.createDiv({ cls: "arena-source-btn" });
      sourceBtn.createSpan({ text: "Source" });
      sourceBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(url, "_blank");
      });
    }

    const label = card.createDiv({ cls: "arena-block-label" });
    label.createSpan({ text: block.name, cls: "arena-block-name" });

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.app.workspace.openLinkText(block.file.path, "", false);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = this.buildBlockContextMenu(block);
      menu.showAtMouseEvent(e);
    });

    if (Platform.isMobile) {
      this.addLongPress(card, (e) => {
        const touch = e.touches[0] || e.changedTouches[0];
        if (touch) {
          const menu = this.buildBlockContextMenu(block);
          this.showContextMenuAtPoint(touch.clientX, touch.clientY, menu);
        }
      });
    }

    if (!Platform.isMobile) {
      card.setAttribute("draggable", "true");
    }
    card.addEventListener("dragstart", (e) => {
      if (e.dataTransfer) {
        e.dataTransfer.setData("text/arena-block-path", block.file.path);
        e.dataTransfer.effectAllowed = "move";
      }
      card.addClass("arena-dragging");
    });
    card.addEventListener("dragend", () => {
      card.removeClass("arena-dragging");
    });
  }

  // ── Drag and Drop ──────────────────────────────────────────────────────────

  setupDropZone(
    el: HTMLElement,
    targetFolder: TFolder,
    options?: {
      clickTarget?: HTMLElement;
      onUrlLoading?: (msg: string) => void;
      onUrlSuccess?: () => Promise<void>;
    },
  ) {
    let dropCounter = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      dropCounter++;
      if (dropCounter === 1) {
        el.addClass("arena-drop-active");
      }
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.dataTransfer) {
        const hasArenaData = e.dataTransfer.types.includes(
          "text/arena-block-path",
        );
        e.dataTransfer.dropEffect = hasArenaData ? "move" : "copy";
      }
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dropCounter--;
      if (dropCounter <= 0) {
        dropCounter = 0;
        el.removeClass("arena-drop-active");
      }
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      dropCounter = 0;
      el.removeClass("arena-drop-active");

      if (!e.dataTransfer) return;

      // 1. Internal block move
      const internalPath = e.dataTransfer.getData("text/arena-block-path");
      if (internalPath) {
        const file = getFileByPath(this.app.vault, internalPath);
        if (file) {
          const newPath = normalizePath(`${targetFolder.path}/${file.name}`);
          if (file.path !== newPath) {
            void this.app.vault.rename(file, newPath).then(() => {
              new Notice(`Moved "${file.name}" to ${targetFolder.name}`);
              this.render();
            });
          }
        }
        return;
      }

      // 2. URL/link drops
      const uriList = e.dataTransfer.getData("text/uri-list");
      const plainText = e.dataTransfer.getData("text/plain");
      const droppedUrl = uriList || plainText || "";

      if (
        droppedUrl &&
        (droppedUrl.startsWith("http://") || droppedUrl.startsWith("https://"))
      ) {
        const trimmedUrl = droppedUrl.trim();
        void this.enqueueUrlBookmark(trimmedUrl, targetFolder);
        return;
      }

      // 3. External file drops
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        void this.importFileList(files, targetFolder);
        return;
      }
    };

    const clickTarget = options?.clickTarget;
    if (clickTarget) {
      const fileInput = el.createEl("input", { type: "file" });
      fileInput.multiple = true;
      fileInput.addClass("arena-file-input-hidden");
      fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files.length > 0) {
          void this.importFileList(fileInput.files, targetFolder).then(() => {
            fileInput.value = "";
          });
        }
      });

      clickTarget.addEventListener("click", (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest("input, button, a")) return;
        e.stopPropagation();
        fileInput.click();
      });
    }

    // Capture phase to intercept before Obsidian
    el.addEventListener("dragenter", onDragEnter, true);
    el.addEventListener("dragover", onDragOver, true);
    el.addEventListener("dragleave", onDragLeave, true);
    el.addEventListener("drop", onDrop, true);
  }

  async importFileList(files: FileList, targetFolder: TFolder) {
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const droppedFile = files[i];
      if (droppedFile.size === 0 && droppedFile.type === "") continue;

      try {
        const arrayBuffer = await droppedFile.arrayBuffer();
        const fileName = this.sanitizeFileName(droppedFile.name);
        let destPath = normalizePath(`${targetFolder.path}/${fileName}`);
        destPath = this.deduplicatePath(destPath);

        await this.app.vault.createBinary(destPath, arrayBuffer);
        added++;
      } catch (err) {
        console.error("Arena: failed to import file", droppedFile.name, err);
        new Notice(`Failed to import "${droppedFile.name}"`);
      }
    }
    if (added > 0) {
      new Notice(
        `Added ${added} file${added > 1 ? "s" : ""} to ${targetFolder.name}`,
      );
      this.render();
    }
  }

  // ── URL Bookmark ───────────────────────────────────────────────────────────

  private async enqueueUrlBookmark(url: string, folder: TFolder) {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const label = this.isImageUrl(url) ? "Saving image…" : "Fetching link…";
    this.pendingBlocks.push({
      id: pendingId,
      label,
      channel: folder.path,
    });
    this.render();
    try {
      if (this.isImageUrl(url)) {
        await this.saveImageFromUrl(url, folder);
      } else {
        await this.saveUrlAsBookmark(url, folder);
      }
    } finally {
      this.pendingBlocks = this.pendingBlocks.filter((p) => p.id !== pendingId);
      this.render();
    }
  }

  /** Parse og:image whether `content` appears before or after `property`. */
  private extractOgImage(html: string): string {
    const patterns = [
      /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) return m[1].trim();
    }
    return "";
  }

  private resolveAbsoluteUrl(baseUrl: string, ref: string): string {
    const trimmed = ref.trim();
    if (!trimmed) return "";
    try {
      if (trimmed.startsWith("//")) return `https:${trimmed}`;
      return new URL(trimmed, baseUrl).href;
    } catch {
      return trimmed;
    }
  }

  async saveUrlAsBookmark(url: string, folder: TFolder) {
    let title = url;
    let description = "";
    let ogImage = "";

    try {
      const response = await requestUrl({ url, method: "GET" });
      const html = response.text;

      const titleMatch =
        html.match(
          /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
        ) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) title = this.sanitizeMetaContent(titleMatch[1]);

      const descMatch =
        html.match(
          /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
        ) ||
        html.match(
          /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
        );
      if (descMatch) description = this.sanitizeMetaContent(descMatch[1]);

      ogImage = this.extractOgImage(html);
    } catch {
      // metadata fetch failed — continue with URL as fallback title
    }

    const safeName = this.sanitizeFileName(
      title
        .slice(0, 80)
        .replace(/[^\w\s-]/g, "")
        .trim() || "bookmark",
    );
    let destPath = normalizePath(`${folder.path}/${safeName}.md`);
    destPath = this.deduplicatePath(destPath);

    // Fetch cover art: use oEmbed for Spotify/SoundCloud, Apify screenshot otherwise.
    // Cover images are stored in the configured assets folder (hidden from channels by default).
    const platform = this.detectPlatform(url);
    let coverImagePath = "";
    let coverArtUrl: string | null = null;

    if (platform) {
      coverArtUrl = await this.fetchOembedCoverArt(url, platform);
    }
    if (!coverArtUrl) {
      coverArtUrl = await this.fetchApifyScreenshot(url);
    }
    if (!coverArtUrl && ogImage) {
      coverArtUrl = this.resolveAbsoluteUrl(url, ogImage);
    }

    if (coverArtUrl) {
      try {
        const imgResponse = await requestUrl({
          url: coverArtUrl,
          method: "GET",
        });
        let coverPath = normalizePath(`${folder.path}/${safeName}-cover.jpg`);
        coverPath = this.deduplicatePath(coverPath);
        await this.app.vault.createBinary(coverPath, imgResponse.arrayBuffer);
        coverImagePath = coverPath;
      } catch {
        // cover art save failed — continue without cover image
      }
    }

    const lines = [
      "---",
      `url: "${url}"`,
      `title: "${title.replace(/"/g, '\\"')}"`,
      `description: "${description.replace(/"/g, '\\"')}"`,
    ];
    if (ogImage) lines.push(`og_image: "${ogImage}"`);
    if (platform) lines.push(`source_platform: "${platform}"`);
    lines.push(`cover_image: "${coverImagePath}"`);
    lines.push(
      `saved: ${new Date().toISOString()}`,
      `type: bookmark`,
      "---",
      "",
      `# [${title}](${url})`,
      "",
    );
    if (description) lines.push(`> ${description}`, "");

    await this.app.vault.create(destPath, lines.join("\n"));
    new Notice(`Bookmarked "${title}"`);
  }

  detectPlatform(url: string): string | null {
    try {
      const hostname = new URL(url).hostname
        .toLowerCase()
        .replace(/^www\./, "");
      if (hostname === "open.spotify.com" || hostname === "spotify.com")
        return "SPOTIFY";
      if (hostname === "soundcloud.com") return "SOUNDCLOUD";
      return null;
    } catch {
      return null;
    }
  }

  async fetchOembedCoverArt(
    url: string,
    platform: string,
  ): Promise<string | null> {
    try {
      let oembedUrl = "";
      if (platform === "SPOTIFY") {
        oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      } else if (platform === "SOUNDCLOUD") {
        oembedUrl = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`;
      }
      if (!oembedUrl) return null;

      const response = await requestUrl({ url: oembedUrl, method: "GET" });
      const data = response.json as { thumbnail_url?: string };
      return data?.thumbnail_url ?? null;
    } catch {
      return null;
    }
  }

  async fetchApifyScreenshot(url: string): Promise<string | null> {
    const token =
      this.plugin.settings.apifyToken.trim() || apifyTokenFromBuild();
    if (!token) return null;

    try {
      const response = await requestUrl({
        url: `https://api.apify.com/v2/acts/apify~screenshot-url/run-sync-get-dataset-items?token=${token}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: [{ url }],
          waitUntil: "networkidle2",
          delay: 0,
          viewportWidth: 1280,
          scrollToBottom: false,
        }),
        throw: false,
      });

      const raw: unknown = response.json;
      if (Array.isArray(raw) && raw.length > 0) {
        const first: unknown = raw[0];
        if (typeof first === "object" && first !== null) {
          const screenshotUrl = (first as Record<string, unknown>)
            .screenshotUrl;
          if (typeof screenshotUrl === "string") return screenshotUrl;
        }
      }
    } catch {
      // screenshot failed — continue without cover image
    }

    return null;
  }

  isImageUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      return /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(pathname);
    } catch {
      return false;
    }
  }

  async saveImageFromUrl(url: string, folder: TFolder) {
    try {
      const response = await requestUrl({ url, method: "GET" });
      const pathname = new URL(url).pathname;
      const rawName = pathname.split("/").pop() || "image";
      const extMatch = rawName.match(/\.(png|jpe?g|gif|webp|svg|bmp)$/i);
      const ext = extMatch ? extMatch[0] : ".jpg";
      const baseName = extMatch ? rawName : rawName + ext;
      const fileName = this.sanitizeFileName(baseName);
      let destPath = normalizePath(`${folder.path}/${fileName}`);
      destPath = this.deduplicatePath(destPath);
      await this.app.vault.createBinary(destPath, response.arrayBuffer);
      new Notice(`Saved image "${fileName}"`);
    } catch (err) {
      console.error("Arena: failed to download image", url, err);
      new Notice("Failed to download image from URL");
    }
  }

  async saveClipboardImage(
    clipboardData: DataTransfer,
    folder: TFolder,
  ): Promise<boolean> {
    const items = Array.from(clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return false;

    const blob = imageItem.getAsFile();
    if (!blob) return false;

    const mimeToExt: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/bmp": "bmp",
    };
    const ext = mimeToExt[imageItem.type] ?? "png";
    const fileName = `pasted-image-${Date.now()}.${ext}`;
    let destPath = normalizePath(`${folder.path}/${fileName}`);
    destPath = this.deduplicatePath(destPath);

    try {
      const arrayBuffer = await blob.arrayBuffer();
      await this.app.vault.createBinary(destPath, arrayBuffer);
      new Notice(`Image added to ${folder.name}`);
      this.render();
      return true;
    } catch (err) {
      console.error("Arena: failed to save pasted image", err);
      new Notice("Failed to save pasted image");
      return false;
    }
  }

  // ── Text Block Creation ────────────────────────────────────────────────────

  async createTextBlock(text: string, folder: TFolder) {
    const firstLine = text.split("\n")[0];
    const slug =
      firstLine
        .slice(0, 60)
        .replace(/[^\w\s-]/g, "")
        .trim() || "note";
    const safeName = this.sanitizeFileName(slug);
    let destPath = normalizePath(`${folder.path}/${safeName}.md`);
    destPath = this.deduplicatePath(destPath);

    const content = [
      "---",
      `cover_image: ""`,
      `saved: ${new Date().toISOString()}`,
      `type: text`,
      "---",
      "",
      text,
      "",
    ].join("\n");

    await this.app.vault.create(destPath, content);
    new Notice(`Created "${safeName}"`);
  }

  // ── Data helpers ───────────────────────────────────────────────────────────

  getChannels(parentFolder?: TFolder): ChannelInfo[] {
    const folder =
      parentFolder ??
      getFolderByPath(
        this.app.vault,
        normalizePath(this.plugin.settings.rootFolder),
      );

    if (!folder) return [];

    const channels: ChannelInfo[] = [];
    const reservedAssetsPath = normalizePath(this.plugin.getAssetsFolderPath());

    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      if (
        !this.plugin.settings.showAssetsInBrowser &&
        normalizePath(child.path) === reservedAssetsPath
      )
        continue;

      const files = child.children.filter(
        (f): f is TFile => f instanceof TFile && f.name !== CHANNEL_META_FILE,
      );

      const subFolders = child.children.filter(
        (f): f is TFolder => f instanceof TFolder,
      );

      const previewImages = files
        .filter((f) => this.isImageFile(f))
        .slice(0, 4);

      const firstChild = child.children[0];
      const initialMtime =
        firstChild instanceof TFile ? firstChild.stat.mtime : 0;
      const lastModified = files.reduce(
        (max, f) => Math.max(max, f.stat.mtime),
        initialMtime,
      );

      channels.push({
        name: child.name,
        path: child.path,
        folder: child,
        blockCount: files.length,
        subChannelCount: subFolders.length,
        lastModified,
        previewFiles:
          previewImages.length > 0 ? previewImages : files.slice(0, 4),
      });
    }

    channels.sort((a, b) => b.lastModified - a.lastModified);
    return channels;
  }

  getSubChannels(folder: TFolder): ChannelInfo[] {
    return this.getChannels(folder);
  }

  getBlocks(folder: TFolder): BlockInfo[] {
    const coveredPaths = new Set<string>();
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const coverPath = this.app.metadataCache.getFileCache(child)?.frontmatter
        ?.cover_image as string | undefined;
      if (coverPath) coveredPaths.add(coverPath);
    }

    return folder.children
      .filter(
        (f): f is TFile =>
          f instanceof TFile &&
          f.name !== CHANNEL_META_FILE &&
          !coveredPaths.has(f.path),
      )
      .map((file) => ({
        file,
        type: this.getBlockType(file),
        name: file.basename,
      }))
      .sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
  }

  getBlockType(file: TFile): BlockInfo["type"] {
    const ext = file.extension.toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext))
      return "image";
    if (ext === "md") return "markdown";
    if (ext === "pdf") return "pdf";
    if (["mp4", "webm", "mov", "avi"].includes(ext)) return "video";
    if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
    return "other";
  }

  isImageFile(file: TFile): boolean {
    return this.getBlockType(file) === "image";
  }

  openChannel(folder: TFolder) {
    if (this.currentChannel) {
      const alreadyInStack = this.navigationStack.some(
        (f) => f.path === this.currentChannel?.path,
      );
      if (!alreadyInStack) {
        this.navigationStack.push(this.currentChannel);
      }
    }
    this.currentChannel = folder;
    this.render();
  }

  sanitizeMetaContent(text: string): string {
    return text
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  sanitizeFileName(name: string): string {
    return name
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  deduplicatePath(path: string): string {
    let finalPath = path;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(finalPath)) {
      const ext = path.match(/\.[^.]+$/)?.[0] || "";
      const base = path.replace(/\.[^.]+$/, "");
      finalPath = `${base}-${counter}${ext}`;
      counter++;
    }
    return finalPath;
  }

  timeAgo(timestamp: number): string {
    if (!timestamp) return "";
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }
}

// ─── Create Channel Modal ────────────────────────────────────────────────────

class CreateChannelModal extends Modal {
  onSubmit: (name: string) => void;

  constructor(app: App, onSubmit: (name: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "New channel" });

    let nameValue = "";

    new Setting(contentEl).setName("Channel name").addText((text) => {
      text.setPlaceholder("Design resources").onChange((value) => {
        nameValue = value;
      });
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && nameValue.trim()) {
          this.onSubmit(nameValue.trim());
          this.close();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 50);
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Create")
        .setCta()
        .onClick(() => {
          if (nameValue.trim()) {
            this.onSubmit(nameValue.trim());
            this.close();
          }
        }),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Import Channel Modal ────────────────────────────────────────────────────

class ImportChannelModal extends Modal {
  onSubmit: (url: string) => void;

  constructor(app: App, onSubmit: (url: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Import Are.na channel" });

    let urlValue = "";

    new Setting(contentEl)
      .setName("Are.na channel URL")
      .setDesc("Paste the URL of the Are.na channel you want to import.")
      .addText((text) => {
        text
          .setPlaceholder("HTTPS://www.are.na/username/channel-slug")
          .onChange((value) => {
            urlValue = value;
          });
        text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" && urlValue.trim()) {
            this.onSubmit(urlValue.trim());
            this.close();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Import")
        .setCta()
        .onClick(() => {
          if (urlValue.trim()) {
            this.onSubmit(urlValue.trim());
            this.close();
          }
        }),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Confirm Modal ───────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Delete")
          .setDestructive()
          .onClick(() => {
            this.onConfirm();
            this.close();
          }),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class ArenaSettingTab extends PluginSettingTab {
  plugin: ArenaPlugin;

  constructor(app: App, plugin: ArenaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override async setControlValue(
    key: string,
    value: unknown,
  ): Promise<void> {
    if (key === "rootFolder") {
      this.plugin.settings.rootFolder =
        typeof value === "string" && value.trim() ? value.trim() : "arena";
      await this.plugin.saveSettings();
      this.update();
      return;
    }
    if (key === "showAssetsInBrowser") {
      this.plugin.settings.showAssetsInBrowser = Boolean(value);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
      return;
    }
    await super.setControlValue(key, value);
  }

  getSettingDefinitions() {
    const defaultAssetsHint = normalizePath(
      `${this.plugin.settings.rootFolder}/assets`,
    );

    return [
      {
        name: "Root folder",
        desc: "The vault folder that contains your channels",
        control: {
          type: "text" as const,
          key: "rootFolder",
        },
      },
      {
        name: "Assets folder",
        desc: "Where bookmark cover images are stored (vault path). Leave empty to use the default path shown as the placeholder. Type to filter folders, or use browse.",
        render: (setting: Setting) => {
          setting.addText((text) => {
            text
              .setPlaceholder(defaultAssetsHint)
              .setValue(this.plugin.settings.assetsFolder);
            const suggest = new FolderPathSuggest(this.app, text.inputEl);
            suggest.onSelect(async (value) => {
              this.plugin.settings.assetsFolder = value;
              await this.plugin.saveSettings();
            });
            text.onChange(async (value) => {
              this.plugin.settings.assetsFolder = value.trim();
              await this.plugin.saveSettings();
            });
          });
          setting.addExtraButton((btn) =>
            btn
              .setIcon("folder")
              .setTooltip("Browse folders")
              .onClick(() => {
                const modal = new PickFolderModal(
                  this.app,
                  collectFolderPaths(this.app.vault.getRoot()),
                  (path) => {
                    this.plugin.settings.assetsFolder = path;
                    void this.plugin.saveSettings();
                    this.update();
                  },
                );
                modal.open();
              }),
          );
        },
      },
      {
        name: "Show assets folder",
        desc: "When off, the assets folder is omitted from the channel list. Turn on to open and manage cover images like any other channel.",
        control: {
          type: "toggle" as const,
          key: "showAssetsInBrowser",
        },
      },
      {
        name: "Are.na access token",
        desc: "Optional. Required for importing private Are.na channels. Generate one at are.na/settings.",
        render: (setting: Setting) => {
          setting.addText((text) => {
            text
              .setPlaceholder("Are.na personal access token")
              .setValue(this.plugin.settings.arenaAccessToken)
              .onChange(async (value) => {
                this.plugin.settings.arenaAccessToken = value.trim();
                await this.plugin.saveSettings();
              });
            text.inputEl.type = "password";
          });
        },
      },
      {
        name: "Apify API token",
        desc: "Optional. Used to generate website screenshots as cover images for bookmarks.",
        render: (setting: Setting) => {
          setting.addText((text) => {
            text
              .setPlaceholder("Apify API token")
              .setValue(this.plugin.settings.apifyToken)
              .onChange(async (value) => {
                this.plugin.settings.apifyToken = value.trim();
                await this.plugin.saveSettings();
              });
            text.inputEl.type = "password";
          });
        },
      },
      {
        name: "Refresh Are.na cover images",
        desc: "Scan all Are.na-imported blocks (link, media, image) that are missing a cover image and fetch one from the Are.na API using each block's arena_id. Useful for channels imported before cover-image support was added. Blocks without an arena_id (manually added notes) are skipped.",
        action: () => {
          void this.plugin.refreshMissingArenaCovers();
        },
      },
      {
        name: "Migrate cover images",
        desc: "Move any existing cover images stored in the assets folder to sit alongside their notes in the channel folder, and update the frontmatter paths accordingly.",
        action: () => {
          void this.plugin.migrateCoverImagesToChannelFolders();
        },
      },
    ];
  }
}
