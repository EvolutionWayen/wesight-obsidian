import { App, Component, MarkdownRenderer, Modal, Setting } from 'obsidian';

import { RECENT_RELEASE_NOTES } from '../update/releaseNotes';

export class ReleaseNotesModal extends Modal {
  private renderComponent: Component | null = null;

  constructor(app: App, private readonly currentVersion: string) { super(app); }

  override onOpen(): void {
    this.setTitle('WeSight 版本更新说明');
    this.modalEl.addClass('wesight-release-notes-modal');
    this.contentEl.addClass('wesight-release-notes');
    this.contentEl.createDiv({ cls: 'wesight-release-notes-current', text: `当前安装版本：${this.currentVersion}` });
    const picker = new Setting(this.contentEl).setName('近期版本');
    const content = this.contentEl.createDiv({ cls: 'wesight-release-notes-body' });
    const showNotes = async (version: string): Promise<void> => {
      const release = RECENT_RELEASE_NOTES.find(item => item.version === version);
      if (!release) return;
      this.renderComponent?.unload();
      this.renderComponent = new Component();
      this.renderComponent.load();
      content.empty();
      const markdown = release.markdown.replace(/\]\((\.\.?\/[^)]+)\)/g, (_match, relative: string) => {
        const base = `https://github.com/freestylefly/wesight-obsidian/blob/${release.version}/docs/releases/`;
        return `](${new URL(relative, base).href})`;
      });
      await MarkdownRenderer.render(this.app, markdown, content, '', this.renderComponent);
    };
    const selected = RECENT_RELEASE_NOTES.find(item => item.version === this.currentVersion)?.version
      ?? RECENT_RELEASE_NOTES[0].version;
    picker.addDropdown(dropdown => {
      for (const release of RECENT_RELEASE_NOTES) dropdown.addOption(release.version, `${release.version} · ${release.title}`);
      dropdown.setValue(selected).onChange(value => void showNotes(value));
    });
    void showNotes(selected);
  }

  override onClose(): void {
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.contentEl.empty();
  }
}
