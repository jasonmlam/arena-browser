import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFolder,
  TFile,
  TAbstractFile,
  Notice,
  Menu,
  Modal,
  Setting,
  PluginSettingTab,
  App,
  normalizePath,
  requestUrl,
} from "obsidian";

// ─── Constants ───────────────────────────────────────────────────────────────

const VIEW_TYPE_ARENA = "arena-browser";
const ICON_ARENA = "layout-grid";
const CHANNEL_META_FILE = "_channel.md";
const DEFAULT_SETTINGS: ArenaPluginSettings = {
  rootFolder: "arena",
  showHiddenFiles: false,
  gridColumns: 4,
  thumbnailSize: 280,
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArenaPluginSettings {
  rootFolder: string;
  showHiddenFiles: boolean;
  gridColumns: number;
  thumbnailSize: number;
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

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class ArenaPlugin extends Plugin {
  settings: ArenaPluginSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_ARENA, (leaf) => new ArenaView(leaf, this));

    this.addRibbonIcon(ICON_ARENA, "Open Arena browser", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-arena-browser",
      name: "Open Arena browser",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "create-arena-channel",
      name: "Create new channel",
      callback: () => this.createChannelDialog(),
    });

    this.addSettingTab(new ArenaSettingTab(this.app, this));
    await this.ensureRootFolder();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ARENA);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ARENA)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_ARENA, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async ensureRootFolder() {
    const root = this.settings.rootFolder;
    const existing = this.app.vault.getAbstractFileByPath(root);
    if (!existing) {
      await this.app.vault.createFolder(root);
    }
  }

  async createChannelDialog(parentFolder?: TFolder) {
    const modal = new CreateChannelModal(this.app, async (name: string) => {
      await this.createChannel(name, parentFolder);
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

    return this.app.vault.getAbstractFileByPath(path) as TFolder;
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_ARENA).forEach((leaf) => {
      const view = leaf.view as ArenaView;
      if (view && view.render) {
        view.render();
      }
    });
  }
}

// ─── Arena View ──────────────────────────────────────────────────────────────

class ArenaView extends ItemView {
  plugin: ArenaPlugin;
  currentChannel: TFolder | null = null;
  navigationStack: TFolder[] = [];

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
    this.render();

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRender = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => this.render(), 200);
    };

    this.registerEvent(this.app.vault.on("create", debouncedRender));
    this.registerEvent(this.app.vault.on("delete", debouncedRender));
    this.registerEvent(this.app.vault.on("rename", debouncedRender));
  }

  async onClose() {
    this.contentEl.empty();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  async render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("arena-container");

    if (this.currentChannel) {
      await this.renderChannel(container, this.currentChannel);
    } else {
      await this.renderChannelGrid(container);
    }

    this.leaf.updateHeader();
  }

  // ── Breadcrumb ─────────────────────────────────────────────────────────────

  renderBreadcrumb(container: HTMLElement) {
    const breadcrumb = container.createDiv({ cls: "arena-breadcrumb" });

    const rootLink = breadcrumb.createEl("span", {
      text: "Arena",
      cls: "arena-breadcrumb-link",
    });
    rootLink.addEventListener("click", () => {
      this.currentChannel = null;
      this.navigationStack = [];
      this.render();
    });

    for (let i = 0; i < this.navigationStack.length; i++) {
      breadcrumb.createEl("span", {
        text: " / ",
        cls: "arena-breadcrumb-sep",
      });

      const folder = this.navigationStack[i];
      const link = breadcrumb.createEl("span", {
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
        breadcrumb.createEl("span", {
          text: " / ",
          cls: "arena-breadcrumb-sep",
        });
        breadcrumb.createEl("span", {
          text: this.currentChannel.name,
          cls: "arena-breadcrumb-current",
        });
      }
    }
  }

  // ── Channel Grid (home view) ───────────────────────────────────────────────

  async renderChannelGrid(container: HTMLElement) {
    const channels = this.getChannels();

    const header = container.createDiv({ cls: "arena-header" });
    header.createEl("h1", { text: "Arena", cls: "arena-title" });

    const actions = header.createDiv({ cls: "arena-header-actions" });
    const newBtn = actions.createEl("button", {
      text: "+ New channel",
      cls: "arena-btn arena-btn-primary",
    });
    newBtn.addEventListener("click", () => {
      this.plugin.createChannelDialog();
    });

    const grid = container.createDiv({ cls: "arena-grid" });
    grid.style.setProperty(
      "--arena-columns",
      String(this.plugin.settings.gridColumns),
    );

    if (channels.length === 0) {
      const empty = grid.createDiv({ cls: "arena-empty" });
      empty.createEl("p", {
        text: "No channels yet. Create one to get started.",
      });
      return;
    }

    for (const channel of channels) {
      if (channel.subChannelCount > 0) {
        this.renderParentChannelCard(grid, channel);
      } else {
        this.renderChannelCard(grid, channel);
      }
    }
  }

  renderParentChannelCard(parent: HTMLElement, channel: ChannelInfo) {
    const subChannels = this.getSubChannels(channel.folder).slice(0, 6);

    // Outer bordered rectangle that wraps the parent + sub-channels
    const wrapper = parent.createDiv({ cls: "arena-parent-row" });

    wrapper.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showChannelContextMenu(e, channel);
    });

    // Inner row: parent card on left, sub-channels on right
    const innerRow = wrapper.createDiv({ cls: "arena-parent-inner" });

    // Parent channel square (left side, fixed size)
    const parentCard = innerRow.createDiv({ cls: "arena-parent-card" });

    const parentInfo = parentCard.createDiv({ cls: "arena-parent-info" });
    parentInfo.createEl("h3", { text: channel.name, cls: "arena-card-title" });

    const parentMeta = parentInfo.createDiv({ cls: "arena-parent-meta" });
    parentMeta.createEl("span", {
      text: `by ${this.getChannelAuthor(channel)}`,
      cls: "arena-card-meta",
    });
    parentMeta.createEl("span", {
      text: `${channel.blockCount} block${channel.blockCount !== 1 ? "s" : ""}`,
      cls: "arena-card-meta",
    });
    parentMeta.createEl("span", {
      text: this.timeAgo(channel.lastModified),
      cls: "arena-card-meta",
    });

    parentCard.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openChannel(channel.folder);
    });

    // Sub-channels to the right of parent
    if (subChannels.length > 0) {
      const subGrid = innerRow.createDiv({ cls: "arena-parent-sub-grid" });

      for (const sub of subChannels) {
        const subCard = subGrid.createDiv({ cls: "arena-sub-channel-card" });

        const subInfo = subCard.createDiv({ cls: "arena-sub-channel-info" });
        subInfo.createEl("h3", {
          text: sub.name,
          cls: "arena-sub-channel-title",
        });

        const subMeta = subInfo.createDiv({ cls: "arena-sub-meta" });
        subMeta.createEl("span", {
          text: `by ${this.getChannelAuthor(sub)}`,
          cls: "arena-card-meta",
        });
        subMeta.createEl("span", {
          text: `${sub.blockCount} block${sub.blockCount !== 1 ? "s" : ""}`,
          cls: "arena-card-meta",
        });
        subMeta.createEl("span", {
          text: this.timeAgo(sub.lastModified),
          cls: "arena-card-meta",
        });

        subCard.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openChannel(sub.folder);
        });
      }
    }
  }

  showChannelContextMenu(e: MouseEvent, channel: ChannelInfo) {
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

    menu.addItem((item) =>
      item
        .setTitle("Reveal in file explorer")
        .setIcon("folder-search")
        .onClick(() => {
          const file = this.app.vault.getAbstractFileByPath(channel.path);
          if (file) {
            (this.app as any).internalPlugins?.plugins?.[
              "file-explorer"
            ]?.instance?.revealInFolder?.(file);
          }
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle("Delete channel")
        .setIcon("trash")
        .onClick(async () => {
          const confirmed = confirm(
            `Delete channel "${channel.name}" and all its contents?`,
          );
          if (confirmed) {
            await this.app.vault.trash(channel.folder, true);
            this.render();
          }
        }),
    );

    menu.showAtMouseEvent(e);
  }

  getChannelAuthor(channel: ChannelInfo): string {
    // Could be extended to read from frontmatter, for now return folder name's context
    return "You";
  }

  renderChannelCard(parent: HTMLElement, channel: ChannelInfo) {
    const card = parent.createDiv({ cls: "arena-card arena-channel-card" });

    if (channel.previewFiles.length > 0) {
      const previews = card.createDiv({ cls: "arena-card-previews" });
      for (const file of channel.previewFiles.slice(0, 4)) {
        if (this.isImageFile(file)) {
          const img = previews.createEl("img", {
            cls: "arena-preview-thumb",
          });
          img.src = this.app.vault.getResourcePath(file);
          img.alt = file.name;
        } else {
          const placeholder = previews.createDiv({
            cls: "arena-preview-placeholder",
          });
          placeholder.createEl("span", {
            text: file.extension.toUpperCase(),
            cls: "arena-preview-ext",
          });
        }
      }
    }

    const info = card.createDiv({ cls: "arena-card-info" });
    info.createEl("h3", { text: channel.name, cls: "arena-card-title" });

    const metaLine = info.createDiv({ cls: "arena-card-meta-row" });
    metaLine.createEl("span", {
      text: `${channel.blockCount} blocks`,
      cls: "arena-card-meta",
    });
    if (channel.subChannelCount > 0) {
      metaLine.createEl("span", {
        text: ` · ${channel.subChannelCount} sub-channels`,
        cls: "arena-card-meta",
      });
    }
    info.createEl("span", {
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

    this.setupDropZone(card, channel.folder);
  }

  // ── Channel View (blocks + sub-channels) ───────────────────────────────────

  async renderChannel(container: HTMLElement, folder: TFolder) {
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
      titleRow.createEl("span", {
        text: countParts.join(" · "),
        cls: "arena-channel-count",
      });
    }

    const actions = header.createDiv({ cls: "arena-header-actions" });
    const newSubBtn = actions.createEl("button", {
      text: "+ Sub-channel",
      cls: "arena-btn arena-btn-primary",
    });
    newSubBtn.addEventListener("click", () => {
      this.plugin.createChannelDialog(folder);
    });

    // Sub-channels
    if (subChannels.length > 0) {
      const subSection = container.createDiv({ cls: "arena-section" });
      subSection.createEl("h2", {
        text: "Sub-channels",
        cls: "arena-section-title",
      });

      const subGrid = subSection.createDiv({ cls: "arena-grid" });
      subGrid.style.setProperty(
        "--arena-columns",
        String(this.plugin.settings.gridColumns),
      );

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
    grid.style.setProperty(
      "--arena-columns",
      String(this.plugin.settings.gridColumns),
    );

    // Drop zone pinned to first position
    const dropZone = grid.createDiv({
      cls: "arena-drop-zone arena-block-card",
    });

    const fileInput = dropZone.createEl("input", { type: "file" });
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      if (fileInput.files && fileInput.files.length > 0) {
        await this.importFileList(fileInput.files, folder);
      }
      fileInput.value = "";
    });

    // Placeholder state
    const placeholder = dropZone.createDiv({
      cls: "arena-drop-zone-placeholder",
    });
    const placeholderText = placeholder.createEl("p", {
      cls: "arena-drop-zone-hint",
    });
    placeholderText.appendText("Drop or ");
    const chooseLink = placeholderText.createEl("span", {
      text: "choose",
      cls: "arena-drop-zone-choose",
    });
    placeholderText.appendText(
      " files, paste a URL (image, video, or link) or type text here",
    );

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
    hintBar.createEl("span", { text: "SHIFT + ENTER FOR LINE BREAK" });

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

    textarea.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = textarea.value.trim();
        if (!text) return;

        if (/^https?:\/\//.test(text)) {
          if (this.isImageUrl(text)) {
            await this.saveImageFromUrl(text, folder);
          } else {
            await this.saveUrlAsBookmark(text, folder);
          }
        } else {
          await this.createTextBlock(text, folder);
        }

        textarea.value = "";
        dropZone.removeClass("arena-drop-zone-editing");
        this.render();
      }
    });

    textarea.addEventListener("blur", () => {
      deactivateEditing();
    });

    this.setupDropZone(dropZone, folder);

    for (const block of blocks) {
      this.renderBlockCard(grid, block);
    }
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
        preview.addClass("arena-block-text");
        this.app.vault.cachedRead(block.file).then((content) => {
          const stripped = content.replace(/^---[\s\S]*?---\n?/, "");
          const lines = stripped.trim().split("\n").slice(0, 6).join("\n");
          preview.createEl("p", { text: lines, cls: "arena-block-excerpt" });
        });
        break;
      }
      case "pdf":
        preview.addClass("arena-block-file");
        preview.createEl("span", { text: "PDF", cls: "arena-file-icon" });
        break;
      case "video":
        preview.addClass("arena-block-file");
        preview.createEl("span", { text: "VIDEO", cls: "arena-file-icon" });
        break;
      case "audio":
        preview.addClass("arena-block-file");
        preview.createEl("span", { text: "AUDIO", cls: "arena-file-icon" });
        break;
      default:
        preview.addClass("arena-block-file");
        preview.createEl("span", {
          text: block.file.extension.toUpperCase(),
          cls: "arena-file-icon",
        });
    }

    const label = card.createDiv({ cls: "arena-block-label" });
    label.createEl("span", { text: block.name, cls: "arena-block-name" });

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      this.app.workspace.openLinkText(block.file.path, "", false);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();

      menu.addItem((item) =>
        item
          .setTitle("Open file")
          .setIcon("file")
          .onClick(() =>
            this.app.workspace.openLinkText(block.file.path, "", false),
          ),
      );
      menu.addItem((item) =>
        item
          .setTitle("Open in new tab")
          .setIcon("file-plus")
          .onClick(() =>
            this.app.workspace.openLinkText(block.file.path, "", "tab"),
          ),
      );
      menu.addItem((item) =>
        item
          .setTitle("Remove from channel")
          .setIcon("trash")
          .onClick(async () => {
            await this.app.vault.trash(block.file, true);
            this.render();
          }),
      );

      menu.showAtMouseEvent(e);
    });

    card.setAttribute("draggable", "true");
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
    options?: { clickTarget?: HTMLElement },
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

    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      dropCounter = 0;
      el.removeClass("arena-drop-active");

      if (!e.dataTransfer) return;

      // 1. Internal block move
      const internalPath = e.dataTransfer.getData("text/arena-block-path");
      if (internalPath) {
        const file = this.app.vault.getAbstractFileByPath(internalPath);
        if (file instanceof TFile) {
          const newPath = normalizePath(`${targetFolder.path}/${file.name}`);
          if (file.path !== newPath) {
            await this.app.vault.rename(file, newPath);
            new Notice(`Moved "${file.name}" to ${targetFolder.name}`);
            this.render();
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
        if (this.isImageUrl(trimmedUrl)) {
          await this.saveImageFromUrl(trimmedUrl, targetFolder);
        } else {
          await this.saveUrlAsBookmark(trimmedUrl, targetFolder);
        }
        this.render();
        return;
      }

      // 3. External file drops
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        await this.importFileList(files, targetFolder);
        return;
      }
    };

    const clickTarget = options?.clickTarget;
    if (clickTarget) {
      const fileInput = el.createEl("input", { type: "file" });
      fileInput.multiple = true;
      fileInput.style.display = "none";
      fileInput.addEventListener("change", async () => {
        if (fileInput.files && fileInput.files.length > 0) {
          await this.importFileList(fileInput.files, targetFolder);
        }
        fileInput.value = "";
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
        destPath = await this.deduplicatePath(destPath);

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
      if (titleMatch) title = titleMatch[1].trim();

      const descMatch =
        html.match(
          /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
        ) ||
        html.match(
          /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
        );
      if (descMatch) description = descMatch[1].trim();

      const imgMatch = html.match(
        /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      );
      if (imgMatch) ogImage = imgMatch[1].trim();
    } catch (err) {
      console.warn("Arena: could not fetch URL metadata", url, err);
    }

    const safeName = this.sanitizeFileName(
      title
        .slice(0, 80)
        .replace(/[^\w\s-]/g, "")
        .trim() || "bookmark",
    );
    let destPath = normalizePath(`${folder.path}/${safeName}.md`);
    destPath = await this.deduplicatePath(destPath);

    const lines = [
      "---",
      `url: "${url}"`,
      `title: "${title.replace(/"/g, '\\"')}"`,
      `description: "${description.replace(/"/g, '\\"')}"`,
    ];
    if (ogImage) lines.push(`og_image: "${ogImage}"`);
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
      destPath = await this.deduplicatePath(destPath);
      await this.app.vault.createBinary(destPath, response.arrayBuffer);
      new Notice(`Saved image "${fileName}"`);
    } catch (err) {
      console.error("Arena: failed to download image", url, err);
      new Notice("Failed to download image from URL");
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
    destPath = await this.deduplicatePath(destPath);

    await this.app.vault.create(destPath, text);
    new Notice(`Created "${safeName}"`);
  }

  // ── Data helpers ───────────────────────────────────────────────────────────

  getChannels(parentFolder?: TFolder): ChannelInfo[] {
    const folder =
      parentFolder ||
      (this.app.vault.getAbstractFileByPath(
        this.plugin.settings.rootFolder,
      ) as TFolder);

    if (!(folder instanceof TFolder)) return [];

    const channels: ChannelInfo[] = [];

    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;

      const files = child.children.filter(
        (f): f is TFile => f instanceof TFile && f.name !== CHANNEL_META_FILE,
      );

      const subFolders = child.children.filter(
        (f): f is TFolder => f instanceof TFolder,
      );

      const previewImages = files
        .filter((f) => this.isImageFile(f))
        .slice(0, 4);

      const lastModified = files.reduce(
        (max, f) => Math.max(max, f.stat.mtime),
        child.children[0] ? (child.children[0] as TFile).stat?.mtime || 0 : 0,
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
    return folder.children
      .filter(
        (f): f is TFile => f instanceof TFile && f.name !== CHANNEL_META_FILE,
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

  sanitizeFileName(name: string): string {
    return name
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  async deduplicatePath(path: string): Promise<string> {
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
      text.setPlaceholder("e.g. design resources").onChange((value) => {
        nameValue = value;
      });
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && nameValue.trim()) {
          this.onSubmit(nameValue.trim());
          this.close();
        }
      });
      setTimeout(() => text.inputEl.focus(), 50);
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

// ─── Settings Tab ────────────────────────────────────────────────────────────

class ArenaSettingTab extends PluginSettingTab {
  plugin: ArenaPlugin;

  constructor(app: App, plugin: ArenaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Arena browser settings" });

    new Setting(containerEl)
      .setName("Root folder")
      .setDesc("The vault folder that contains your channels")
      .addText((text) =>
        text
          .setPlaceholder("arena")
          .setValue(this.plugin.settings.rootFolder)
          .onChange(async (value) => {
            this.plugin.settings.rootFolder = value || "arena";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Grid columns")
      .setDesc("Number of columns in the channel/block grid")
      .addSlider((slider) =>
        slider
          .setLimits(2, 5, 1)
          .setValue(this.plugin.settings.gridColumns)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.gridColumns = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }),
      );
  }
}
