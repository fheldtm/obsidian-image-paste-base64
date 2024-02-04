import { App, Editor, MarkdownFileInfo, MarkdownView, Plugin, Notice, type TFile, PluginSettingTab, Setting, Modal, ButtonComponent } from 'obsidian';
import { v4 } from 'uuid';

interface MyPluginSettings {
	BASE64_DIR: string;
  BASE64_FILENAME: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	BASE64_DIR: '.image-base64',
  BASE64_FILENAME: 'image-base64.json'
}

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      resolve(reader.result?.toString() || '');
    };
    reader.onerror = () => reject('');
  })
}

const getImageMap = async (plugin: ImagePasteBase64Plugin) => {
  const adapter = plugin.app.vault.adapter as any;
  const path = adapter.path;

  const dirpath = path.join(plugin.settings.BASE64_DIR);
  const isImageDir = await adapter.exists(dirpath)
  if (!isImageDir) {
    await adapter.mkdir(dirpath)
  }

  const filepath = path.join(plugin.settings.BASE64_DIR, plugin.settings.BASE64_FILENAME);
  const isImageJSON = await adapter.exists(filepath)
  if (!isImageJSON) {
    await adapter.write(filepath, JSON.stringify({}, null, 2))
  }

  return JSON.parse(await adapter.read(filepath));
}

const updateImageMap = async (plugin: ImagePasteBase64Plugin, name: string, base64: string, filepath: string): Promise<string> => {
  if (filepath === '') {
    // notify
    new Notice('Invalid file path.')
    return '';
  }

  // uuid 생성
  const uuid = v4();

  // 이미지 맵 가져오기
  const imageMap = await getImageMap(plugin)

  // uuid가 이미 존재한다면, uuid를 새로 생성합니다.
  if (imageMap[uuid]) {
    return await updateImageMap(plugin, name, base64, filepath)
  }

  // imageMap의 value값들을 조회하여 같은 base64가 존재한다면 uuid를 반환합니다.
  const existBase64 = Object.values(imageMap).find((src) => src === base64)
  if (existBase64) {
    const fileUUID = Object.keys(imageMap).find((key) => imageMap[key] === existBase64) || ''
    return fileUUID;
  }

  // imageMap에 uuid를 추가합니다.
  imageMap[uuid] = base64

  // imageMap을 저장합니다.
  const adapter = plugin.app.vault.adapter as any;
  const path = adapter.path;

  await adapter.write(
    path.join(plugin.settings.BASE64_DIR, plugin.settings.BASE64_FILENAME),
    JSON.stringify(imageMap, null, 2)
  )

  // uuid를 반환합니다.
  return uuid;
}

const updateImageJSON = async (markdownFiles: TFile[], plugin: ImagePasteBase64Plugin) => {
  const idArrays = await Promise.all(
    markdownFiles.map(async (file) => {
      const content = await plugin.app.vault.adapter.read(file.path);

      // ```image-base64 ~ ``` 사이의 내용을 가져오는 정규식
      const regex = /```image-base64([\s\S]*?)```/g;
      const matches = content.match(regex);

      // 해당 matches 에서 id: uuid에서 uuid를 가져오는 정규식
      const idRegex = /id: ([\s\S]*?)\n/g;
      const idMatches = matches?.map((match) => match.match(idRegex)?.[0] || '').map((id) => id.replace('id: ', '').replace('\n', '')) || [];

      return idMatches;
    })
  );

  const imageIds = [
    'encryptedImageJsonData',
    ...new Set(idArrays.flatMap((idArray) => idArray))
  ];

  const imageMap = await getImageMap(plugin);
  const imageKeys = Object.keys(imageMap);
  const deletedImageKeys = imageKeys.filter((key) => !imageIds.includes(key));

  if (deletedImageKeys.length === 0) return;

  new UnusedImageCheckModal(plugin, deletedImageKeys).open();
}

export default class ImagePasteBase64Plugin extends Plugin {
  settings: MyPluginSettings;

  async onload () {
    this.loadSettings();

    this.registerMarkdownCodeBlockProcessor('image-base64', async (source, el, ctx) => {
      const imageMap = await getImageMap(this)

      const lines = source.split('\n');
      const imgName = lines.find(line => line.includes('name:'))?.split('name:')[1]?.trim() || `pasted-image-${Date.now()}`;
      const imgId = lines.find(line => line.includes('id:'))?.split('id:')[1]?.trim() || '';

      // add img tag to el
      const img = document.createElement('img');
      img.src = imageMap[imgId];
      img.alt = imgName;
      await new Promise((resolve) => img.onload = () => resolve(''));
      el.appendChild(img);
      el.parentElement?.classList.add('image-base64-container');
      el.nextElementSibling?.setAttribute('aria-label', '');
    });

    const writeMarkdown = async (fileId: string, editor: Editor, info: MarkdownView | MarkdownFileInfo, multi = false) => {
      const filename = `pasted-image-${Date.now()}`;
      const path = info.file?.path;

      const uuid = await updateImageMap(this, filename, fileId, path || '')
      if (uuid === '') return;

      let fileMarkdown = '```image-base64\n';
      fileMarkdown += `name: ${filename}\n`;
      fileMarkdown += `id: ${uuid}\n`;
      fileMarkdown += '```\n';
      if (multi) {
        fileMarkdown += '\n';
      }

      const currentLineContent = editor.getLine(editor.getCursor().line)
      currentLineContent === ''
        ? editor.replaceSelection(fileMarkdown)
        : editor.replaceSelection(`\n${fileMarkdown}\n`);
    }

    const fileConverter = async (files: FileList, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
      for (let i = 0; i < files.length; i++) {
        // file to base64
        const fileId = await fileToBase64(files[i])
        await writeMarkdown(fileId, editor, info, files.length > 1);
      }
    }

    this.registerEvent(
      this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const { files } = evt.clipboardData || {};
        if (!files?.length) return;

        evt.preventDefault();
        
        await fileConverter(files, editor, info);
        return
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-drop', async (evt: any, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const { files } = evt.dataTransfer || {};
        const imageHTML = evt.dataTransfer.getData('text/html')
        
        if (!files?.length && !imageHTML) return;
        evt.preventDefault();

        if (files?.length > 0) {
          await fileConverter(files, editor, info);
        } else {
          const src = imageHTML.match(/src="(.*?)"/g)[0].replace('src="', '').replace('"', '');

          await writeMarkdown(src, editor, info);
        }
        return;
      })
    )

    this.addSettingTab(new ImagePasteBase64SettingTab(this.app, this));

    // Unused image check
    this.addRibbonIcon('trash', 'Remove unused base64 image', (evt: MouseEvent) => {
      updateImageJSON(this.app.vault.getMarkdownFiles(), this);
		});
    // command
    this.addCommand({
      id: 'remove-unused-base64-image',
      name: 'Remove unused base64 image',
      callback: () => {
        updateImageJSON(this.app.vault.getMarkdownFiles(), this);
      }
    });

    const interval = window.setInterval(() => {
      const markdownFiles = this.app.vault.getMarkdownFiles();
      if (markdownFiles.length === 0) return;
      clearInterval(interval);

      updateImageJSON(markdownFiles, this);
    }, 100)
    this.registerInterval(interval);
  }

  async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class UnusedImageCheckModal extends Modal {
  keys: string[];
  keyIndex: number;
  plugin: ImagePasteBase64Plugin;

	constructor(plugin: ImagePasteBase64Plugin, key: string[]) {
		super(plugin.app);

    this.keys = key;
    this.plugin = plugin;
    this.keyIndex = 0;
	}

	async onOpen() {
		const { contentEl } = this;

    // create header
    contentEl.createEl('h2', {
      text: 'Unused Image Check',
      attr: {
        style: 'margin: 0;'
      }
    });

		contentEl.createEl('p', {
      text: 'Are you sure you want to delete the unused base64 image?'
    });

    const iamgeWrap = contentEl.createEl('div', {
      attr: {
        style: 'width: 100%; display: flex; justify-content: center;'
      }
    });
    
    this.showImage(iamgeWrap)

    const btnWrap = contentEl.createEl('div', {
      attr: {
        style: 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;'
      }
    })

    // skip button
    new ButtonComponent(btnWrap)
      .setButtonText('Skip')
      .onClick(() => {
        this.keyIndex = this.keyIndex += 1;
        if (this.keyIndex === this.keys.length) {
          this.close();
          return;
        }

        this.showImage(iamgeWrap)
      })

    // delete button
    new ButtonComponent(btnWrap)
      .setButtonText('Delete')
      .onClick(async () => {
        const key = this.keys[this.keyIndex];
        const imageMap = await getImageMap(this.plugin);
        delete imageMap[key];
        this.plugin.app.vault.adapter.write(
          (this.plugin.app.vault.adapter as any).path.join(this.plugin.settings.BASE64_DIR, this.plugin.settings.BASE64_FILENAME),
          JSON.stringify(imageMap, null, 2)
        )
        this.keyIndex = this.keyIndex += 1;
        if (this.keyIndex === this.keys.length) {
          this.close();
          return;
        }

        this.showImage(iamgeWrap)
      })
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

  async showImage (wrap: HTMLElement) {
    const imageMap = await getImageMap(this.plugin);
    const key = this.keys[this.keyIndex];
    const imageBase64 = imageMap[key];

    wrap.empty();

    wrap.createEl('img', {
      attr: {
        src: imageBase64,
        style: 'width: auto; max-width: 100%; max-height: 250px;'
      }
    })
  }
}

class ImagePasteBase64SettingTab extends PluginSettingTab {
	plugin: ImagePasteBase64Plugin;

	constructor(app: App, plugin: ImagePasteBase64Plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Base64 file\' directory')
			.setDesc('Enter the directory where the base64 file will be saved.')
			.addText(text => text
				.setPlaceholder('Enter the directory path.')
				.setValue(this.plugin.settings.BASE64_DIR)
				.onChange(async (value) => {
					this.plugin.settings.BASE64_DIR = value;
					await this.plugin.saveSettings();
				}));
	}
} 