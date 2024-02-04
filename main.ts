import { App, Editor, MarkdownFileInfo, MarkdownView, Plugin, Notice, type TFile, PluginSettingTab, Setting } from 'obsidian';
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
  const filepath = path.join(plugin.settings.BASE64_DIR, plugin.settings.BASE64_FILENAME);
  const isImageJSON = await adapter.exists(filepath)
  return JSON.parse(isImageJSON ? await adapter.read(filepath) : '{}')
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
  const hashArrays = await Promise.all(
    markdownFiles.map(async (file) => {
      const content = await plugin.app.vault.adapter.read(file.path);

      // ```image-base64 ~ ``` 사이의 내용을 가져오는 정규식
      const regex = /```image-base64([\s\S]*?)```/g;
      const matches = content.match(regex);

      // 해당 matches 에서 hash: uuid에서 uuid를 가져오는 정규식
      const hashRegex = /hash: ([\s\S]*?)\n/g;
      const hashMatches = matches?.map((match) => match.match(hashRegex)?.[0] || '').map((hash) => hash.replace('hash: ', '').replace('\n', '')) || [];

      return hashMatches;
    })
  );

  const imageHashs = [
    'encryptedImageJsonData',
    ...new Set(hashArrays.flatMap((hashArray) => hashArray))
  ];

  const imageMap = await getImageMap(plugin);
  const imageKeys = Object.keys(imageMap);
  const deletedImageKeys = imageKeys.filter((key) => !imageHashs.includes(key));

  deletedImageKeys.forEach((key) => {
    delete imageMap[key];
  })

  const adapter = plugin.app.vault.adapter as any;
  const path = adapter.path;
  await adapter.write(
    path.join(plugin.settings.BASE64_DIR, plugin.settings.BASE64_FILENAME),
    JSON.stringify(imageMap, null, 2)
  )
}

export default class ImagePasteBase64Plugin extends Plugin {
  settings: MyPluginSettings;

  async onload () {
    this.loadSettings();

    this.registerMarkdownCodeBlockProcessor('image-base64', async (source, el, ctx) => {
      const imageMap = await getImageMap(this)

      const lines = source.split('\n');
      const imgName = lines.find(line => line.includes('name:'))?.split('name:')[1]?.trim() || `pasted-image-${Date.now()}`;
      const imgHash = lines.find(line => line.includes('hash:'))?.split('hash:')[1]?.trim() || '';

      // add img tag to el
      const img = document.createElement('img');
      img.src = imageMap[imgHash];
      img.alt = imgName;
      await new Promise((resolve) => img.onload = () => resolve(''));
      el.appendChild(img);
      el.parentElement?.classList.add('image-base64-container');
      el.nextElementSibling?.setAttribute('aria-label', '');
    });

    const writeMarkdown = async (fileHash: string, editor: Editor, info: MarkdownView | MarkdownFileInfo, multi = false) => {
      const filename = `pasted-image-${Date.now()}`;
      const path = info.file?.path;

      const uuid = await updateImageMap(this, filename, fileHash, path || '')
      if (uuid === '') return;

      let fileMarkdown = '```image-base64\n';
      fileMarkdown += `name: ${filename}\n`;
      fileMarkdown += `hash: ${uuid}\n`;
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
        const fileHash = await fileToBase64(files[i])
        await writeMarkdown(fileHash, editor, info, files.length > 1);
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