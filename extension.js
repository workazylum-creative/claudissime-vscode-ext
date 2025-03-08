const vscode = require('vscode');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('Extension "Claudissime" is now active!');

  // Command to start the chat
  let startChatCmd = vscode.commands.registerCommand('claudissime.startChat', () => {
    ClaudePanel.createOrShow(context.extensionUri);
  });
  
  // Command to generate unit tests
  let unitTestsCmd = vscode.commands.registerCommand('claudissime.generateUnitTests', async () => {
    const panel = await ensurePanelExists(context.extensionUri);
    await panel.generateTests('unit');
  });
  
  // Command to generate functional tests
  let functionalTestsCmd = vscode.commands.registerCommand('claudissime.generateFunctionalTests', async () => {
    const panel = await ensurePanelExists(context.extensionUri);
    await panel.generateTests('functional');
  });
  
  // Command to analyze and upgrade the project
  let upgradeProjectCmd = vscode.commands.registerCommand('claudissime.upgradeProject', async () => {
    const panel = await ensurePanelExists(context.extensionUri);
    await panel.upgradeProject();
  });

  context.subscriptions.push(startChatCmd, unitTestsCmd, functionalTestsCmd, upgradeProjectCmd);
  
  // Fonction utilitaire pour s'assurer que le panneau existe
  async function ensurePanelExists(extensionUri) {
    if (!ClaudePanel.currentPanel) {
      ClaudePanel.createOrShow(extensionUri);
      // Attendre que le panneau soit prêt
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return ClaudePanel.currentPanel;
  }
}

/**
 * Gestion du panneau de chat Claude
 */
class ClaudePanel {
  static currentPanel = undefined;
  static viewType = 'claudissimeView';
  
  // Templates pour les différents types de prompts
  static PROMPT_TEMPLATES = {
    unitTest: `Analyze the following code and generate appropriate unit tests.
    
File: {{fileName}}
Language: {{language}}

Code to test:
\`\`\`{{language}}
{{content}}
\`\`\`

Generate comprehensive unit tests that:
1. Test all core functionalities
2. Include edge cases and error scenarios
3. Use standard testing frameworks for {{language}} (Jest, Mocha, pytest, JUnit, etc.)
4. Follow unit testing best practices
5. Include comments explaining test rationale
`,

    functionalTest: `Analyze the following code and generate appropriate functional/integration tests.
    
File: {{fileName}}
Language: {{language}}

Code to test:
\`\`\`{{language}}
{{content}}
\`\`\`

Project context (if available):
{{projectContext}}

Generate functional tests that:
1. Test complete flows and component integrations
2. Simulate user and API interactions where necessary
3. Use appropriate functional testing frameworks (Cypress, Selenium, Playwright, etc.)
4. Follow functional testing best practices
5. Include comments explaining each test scenario
`,

    upgradeProject: `Analyze the following project and propose a comprehensive upgrade plan.
    
Main or representative file:
\`\`\`{{language}}
{{content}}
\`\`\`

Package.json or dependency file:
\`\`\`json
{{dependencies}}
\`\`\`

Project context:
{{projectContext}}

Please provide:
1. Analysis of outdated dependencies and recommended versions
2. Required code changes for compatibility with new versions
3. Best practices to adopt with the new versions
4. New version features that could improve the project
5. Step-by-step migration action plan
6. Potential risks and mitigation strategies
`
  };

  static createOrShow(extensionUri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // Si le panneau existe déjà, le montrer
    if (ClaudePanel.currentPanel) {
      ClaudePanel.currentPanel._panel.reveal(column);
      return;
    }

    // Sinon, créer un nouveau panneau
    const panel = vscode.window.createWebviewPanel(
      ClaudePanel.viewType,
      'Claude Assistant',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'resources')
        ]
      }
    );

    ClaudePanel.currentPanel = new ClaudePanel(panel, extensionUri);
  }

  constructor(panel, extensionUri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._disposables = [];
    this._history = []; // Pour stocker l'historique des conversations

    // Initialiser le contenu du webview
    this._update();

    // Gérer les messages du webview
    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'sendMessage':
            await this._handleChatMessage(message.text);
            return;
          case 'getEditorContent':
            this._sendEditorContent();
            return;
          case 'insertCodeIntoEditor':
            await this._insertCodeIntoEditor(message.code);
            return;
          case 'createFile':
            await this._createFile(message.filePath, message.content);
            return;
        }
      },
      null,
      this._disposables
    );

    // Nettoyer quand le panneau est fermé
    this._panel.onDidDispose(
      () => {
        ClaudePanel.currentPanel = undefined;
        
        // Nettoyer les ressources
        while (this._disposables.length) {
          const x = this._disposables.pop();
          if (x) {
            x.dispose();
          }
        }
      },
      null,
      this._disposables
    );
  }

  async _handleChatMessage(text, systemPrompt = null) {
    // Récupérer la clé API
    const config = vscode.workspace.getConfiguration('claudissime');
    const apiKey = config.get('apiKey');
    const model = config.get('defaultModel') || "claude-3-opus-20240229";
    const maxTokens = config.get('maxTokens') || 4000;
    
    if (!apiKey) {
      this._panel.webview.postMessage({
        type: 'error',
        value: 'Clé API manquante. Configurez-la dans les paramètres.'
      });
      return;
    }

    try {
      // Afficher l'état de chargement
      this._panel.webview.postMessage({
        type: 'loading',
        value: true
      });

      // Initialiser le client Claude
      const anthropic = new Anthropic({
        apiKey: apiKey,
      });

      // Contexte actuel (fichier ouvert, sélection, etc.)
      const context = await this._getCurrentContext();
      
      // Préparer les messages pour l'API
      let messages = [];
      
      // Ajouter l'historique de la conversation (limité aux 10 derniers messages)
      if (this._history.length > 0) {
        messages = [...this._history.slice(-10)];
      }
      
      // Ajouter le message actuel de l'utilisateur
      const userPrompt = systemPrompt || `Je suis en train de développer dans VSCode. Voici le contexte actuel:
            
Fichier actif: ${context.fileName}
Langage: ${context.language}
Contenu:
\`\`\`${context.language}
${context.content}
\`\`\`

${context.selection !== 'Aucune sélection' ? `Sélection actuelle:
\`\`\`${context.language}
${context.selection}
\`\`\`
` : ''}

${context.projectContext ? `${context.projectContext}\n` : ''}
${context.dependencies ? `Informations sur les dépendances:\n\`\`\`\n${context.dependencies}\n\`\`\`\n` : ''}

Ma question ou demande est:
${text}

En plus de répondre à ma question:
1. Si ta réponse contient du code que je pourrais vouloir utiliser, ajoute une action "Insérer ce code" après chaque bloc de code significatif
2. Si tu proposes de créer un nouveau fichier, ajoute une action "Créer ce fichier" avec le chemin suggéré
3. N'hésite pas à proposer des refactorisations ou des améliorations si tu en vois`;
      
      messages.push({
        role: "user",
        content: userPrompt
      });

      // Send request to Claude API
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: maxTokens,
        messages: messages,
        system: "You are Claudissime, an expert coding assistant integrated with VS Code. Your purpose is to help developers write, test, debug, and improve code. When you provide code, ensure it's complete, well-formatted, and ready to use. You can insert special tags like <insert-code> and <create-file path=\"...\"> that the extension will understand as actionable items for the user. Always focus on providing practical, production-ready solutions that follow best practices for the relevant language and framework."
      });
      
      // Stocker dans l'historique
      this._history.push({
        role: "user",
        content: text
      });
      
      this._history.push({
        role: "assistant",
        content: response.content[0].text
      });

      // Traiter la réponse pour ajouter des boutons d'action
      const processedResponse = this._processResponseWithActions(response.content[0].text);
      
      // Envoyer la réponse au webview
      this._panel.webview.postMessage({
        type: 'response',
        value: processedResponse
      });
    } catch (error) {
      console.error('Erreur API Claude:', error);
      this._panel.webview.postMessage({
        type: 'error',
        value: `Erreur: ${error.message}`
      });
    } finally {
      // Désactiver l'état de chargement
      this._panel.webview.postMessage({
        type: 'loading',
        value: false
      });
    }
  }
  
  _processResponseWithActions(response) {
    // Remplacer les balises <insert-code> par des boutons d'action
    let processedResponse = response.replace(/\<insert-code\>(.*?)\<\/insert-code\>/gs, 
      (match, code) => {
        return `\n\n<div class="action-button" data-action="insertCode" data-code="${this._escapeHtml(code)}">📋 Insérer ce code</div>\n\n`;
      });
    
    // Remplacer les balises <create-file> par des boutons d'action
    processedResponse = processedResponse.replace(/\<create-file path="(.*?)"\>(.*?)\<\/create-file\>/gs, 
      (match, path, content) => {
        return `\n\n<div class="action-button" data-action="createFile" data-path="${this._escapeHtml(path)}" data-content="${this._escapeHtml(content)}">📁 Créer le fichier ${path}</div>\n\n`;
      });
    
    // Ajouter des boutons après les blocs de code (si pas déjà présents)
    processedResponse = processedResponse.replace(/\`\`\`[a-z]*\n([\s\S]*?)\n\`\`\`(?!\n\n<div class="action-button")/g, 
      (match, codeBlock) => {
        return `${match}\n\n<div class="action-button" data-action="insertCode" data-code="${this._escapeHtml(codeBlock)}">📋 Insérer ce code</div>\n`;
      });
    
    return processedResponse;
  }
  
  _escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async _getCurrentContext() {
    const editor = vscode.window.activeTextEditor;
    let context = {
      fileName: 'Aucun fichier ouvert',
      language: 'Inconnu',
      content: '',
      selection: 'Aucune sélection',
      projectContext: '',
      dependencies: ''
    };

    if (editor) {
      const document = editor.document;
      context.fileName = document.fileName;
      context.language = document.languageId;
      context.content = document.getText();
      
      const selection = editor.selection;
      if (!selection.isEmpty) {
        context.selection = document.getText(selection);
      }
      
      // Essayer de trouver des informations sur le projet
      await this._enrichWithProjectInfo(context);
    }

    return context;
  }
  
  async _enrichWithProjectInfo(context) {
    try {
      // Obtenir le dossier de travail
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) return;
      
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
      // Chercher package.json ou équivalent selon le langage
      const dependencyFiles = [
        { name: 'package.json', type: 'npm' },
        { name: 'pom.xml', type: 'maven' },
        { name: 'build.gradle', type: 'gradle' },
        { name: 'requirements.txt', type: 'python' },
        { name: 'Gemfile', type: 'ruby' },
        { name: 'composer.json', type: 'php' }
      ];
      
      for (const file of dependencyFiles) {
        const filePath = path.join(workspaceRoot, file.name);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          context.dependencies = content;
          break;
        }
      }
      
      // Rechercher des fichiers de configuration importants
      const configFiles = [
        'tsconfig.json',
        '.eslintrc',
        'jest.config.js',
        'webpack.config.js',
        'babel.config.js',
        'vite.config.js',
        'tailwind.config.js',
        'next.config.js',
        'nuxt.config.js',
        'angular.json',
        'pytest.ini',
        '.gitlab-ci.yml',
        '.github/workflows',
        'Dockerfile'
      ];
      
      let projectInfo = '';
      for (const configFile of configFiles) {
        const filePath = path.join(workspaceRoot, configFile);
        if (fs.existsSync(filePath)) {
          if (fs.lstatSync(filePath).isDirectory()) {
            projectInfo += `Le projet utilise ${configFile}\n`;
          } else {
            projectInfo += `Le projet contient ${configFile}\n`;
          }
        }
      }
      
      // Ajouter des méta-informations sur le projet
      context.projectContext = `Informations sur le projet:
- Dossier racine: ${path.basename(workspaceRoot)}
- Configuration détectée: ${projectInfo || 'Aucune configuration standard détectée'}
- Nombre de fichiers: ${await this._countFiles(workspaceRoot)}`;
    } catch (error) {
      console.error('Erreur lors de l\'enrichissement des infos projet:', error);
    }
  }
  
  async _countFiles(directory) {
    try {
      const files = await vscode.workspace.findFiles('**/*.*', '**/node_modules/**');
      return files.length;
    } catch (error) {
      console.error('Erreur lors du comptage des fichiers:', error);
      return 'Inconnu';
    }
  }

  async _sendEditorContent() {
    const context = await this._getCurrentContext();
    this._panel.webview.postMessage({
      type: 'editorContent',
      value: context
    });
  }
  
  async _insertCodeIntoEditor(code) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._panel.webview.postMessage({
        type: 'error',
        value: 'Aucun éditeur actif pour insérer le code.'
      });
      return;
    }
    
    try {
      await editor.edit(editBuilder => {
        // Si il y a une sélection, la remplacer, sinon insérer à la position du curseur
        if (!editor.selection.isEmpty) {
          editBuilder.replace(editor.selection, code);
        } else {
          editBuilder.insert(editor.selection.active, code);
        }
      });
      
      this._panel.webview.postMessage({
        type: 'info',
        value: 'Code inséré avec succès!'
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'error',
        value: `Erreur lors de l'insertion du code: ${error.message}`
      });
    }
  }
  
  async _createFile(filePath, content) {
    try {
      // Vérifier si un espace de travail est ouvert
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        throw new Error('Aucun espace de travail ouvert');
      }
      
      // Résoudre le chemin par rapport à la racine du workspace
      const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      let resolvedPath = filePath;
      
      // Si le chemin n'est pas absolu, le rattacher à la racine du workspace
      if (!path.isAbsolute(filePath)) {
        resolvedPath = path.join(workspaceRoot, filePath);
      }
      
      // S'assurer que le dossier parent existe
      const directory = path.dirname(resolvedPath);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }
      
      // Créer le fichier
      fs.writeFileSync(resolvedPath, content, 'utf8');
      
      // Ouvrir le fichier dans l'éditeur
      const document = await vscode.workspace.openTextDocument(resolvedPath);
      await vscode.window.showTextDocument(document);
      
      this._panel.webview.postMessage({
        type: 'info',
        value: `Fichier créé avec succès: ${filePath}`
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'error',
        value: `Erreur lors de la création du fichier: ${error.message}`
      });
    }
  }
  
  async generateTests(type) {
    const context = await this._getCurrentContext();
    
    if (context.fileName === 'Aucun fichier ouvert') {
      this._panel.webview.postMessage({
        type: 'error',
        value: 'Aucun fichier ouvert pour générer des tests.'
      });
      return;
    }
    
    // Obtenir le template en fonction du type
    let promptTemplate = type === 'unit' 
      ? ClaudePanel.PROMPT_TEMPLATES.unitTest 
      : ClaudePanel.PROMPT_TEMPLATES.functionalTest;
    
    // Remplacer les variables dans le template
    const prompt = promptTemplate
      .replace(/{{fileName}}/g, context.fileName)
      .replace(/{{language}}/g, context.language)
      .replace(/{{content}}/g, context.content)
      .replace(/{{projectContext}}/g, context.projectContext || 'Non disponible');
    
    // Simuler un message utilisateur
    this._panel.webview.postMessage({
      type: 'userMessage',
      value: `Générer des tests ${type === 'unit' ? 'unitaires' : 'fonctionnels'} pour le fichier actuel.`
    });
    
    // Appeler l'API Claude avec le prompt spécifique
    await this._handleChatMessage('', prompt);
  }
  
  async upgradeProject() {
    const context = await this._getCurrentContext();
    
    if (!context.dependencies) {
      this._panel.webview.postMessage({
        type: 'error',
        value: 'Aucun fichier de dépendances trouvé (package.json, pom.xml, etc.). Impossible d\'analyser le projet pour une mise à niveau.'
      });
      return;
    }
    
    // Obtenir le template
    let promptTemplate = ClaudePanel.PROMPT_TEMPLATES.upgradeProject;
    
    // Remplacer les variables dans le template
    const prompt = promptTemplate
      .replace(/{{language}}/g, context.language)
      .replace(/{{content}}/g, context.content)
      .replace(/{{dependencies}}/g, context.dependencies)
      .replace(/{{projectContext}}/g, context.projectContext || 'Non disponible');
    
    // Simuler un message utilisateur
    this._panel.webview.postMessage({
      type: 'userMessage',
      value: 'Analyser le projet pour une mise à niveau et proposer des améliorations.'
    });
    
    // Appeler l'API Claude avec le prompt spécifique
    await this._handleChatMessage('', prompt);
  }

  _update() {
    const webview = this._panel.webview;
    this._panel.title = "Claudissime";
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  _getHtmlForWebview(webview) {
    const blocReplacementRegexp = /\`\`\`([^`]+)\`\`\`/g;
    const inlineCodeReplacementRegexp = /\`([^`]+)\`/g;
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claudissime</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      margin: 0;
      padding: 0;
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
    }
    .container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      max-width: 100%;
      margin: 0 auto;
    }
    .chat-messages {
      flex-grow: 1;
      overflow-y: auto;
      padding: 16px;
    }
    .message {
      margin-bottom: 16px;
      padding: 12px;
      border-radius: 6px;
      max-width: 80%;
    }
    .user-message {
      background-color: var(--vscode-editor-selectionBackground);
      color: var(--vscode-editor-selectionForeground);
      align-self: flex-end;
      margin-left: auto;
    }
    .assistant-message {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      align-self: flex-start;
    }
    .input-container {
      display: flex;
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .message-input {
      flex-grow: 1;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      resize: none;
      height: 40px;
      max-height: 150px;
      overflow-y: auto;
    }
    .send-button {
      margin-left: 8px;
      padding: 8px 16px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .context-button {
      margin-left: 8px;
      padding: 8px;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .loading {
      text-align: center;
      margin: 20px 0;
    }
    pre {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    .error {
      color: var(--vscode-errorForeground);
      background-color: var(--vscode-inputValidation-errorBackground);
      padding: 8px;
      border-radius: 4px;
      margin: 8px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="chat-messages" id="chatMessages">
      <div class="message assistant-message">
        <h2>Welcome to Claudissime!</h2>
        <p>I'm your AI-powered coding companion. Here to help you:</p>
        <ul>
          <li>Write and refactor code</li>
          <li>Generate unit and functional tests</li>
          <li>Debug problems</li>
          <li>Upgrade your project</li>
          <li>Explain concepts</li>
        </ul>
        <p>How can I assist with your development today?</p>
      </div>
    </div>
    <div id="loadingIndicator" class="loading" style="display: none;">
      En attente de réponse...
    </div>
    <div class="input-container">
      <textarea 
        id="messageInput" 
        class="message-input" 
        placeholder="Ask a question or request help..."
        rows="1"></textarea>
      <button id="contextButton" class="context-button" title="Get current context">📋</button>
      <button id="sendButton" class="send-button">Send</button>
    </div>
  </div>

  <script>
    (function() {
      // Éléments du DOM
      const vscode = acquireVsCodeApi();
      const messageInput = document.getElementById('messageInput');
      const sendButton = document.getElementById('sendButton');
      const contextButton = document.getElementById('contextButton');
      const chatMessages = document.getElementById('chatMessages');
      const loadingIndicator = document.getElementById('loadingIndicator');

      // Ajuster automatiquement la hauteur du textarea
      messageInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
      });

      // Envoi du message par le bouton ou Entrée
      sendButton.addEventListener('click', sendMessage);
      messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendMessage();
        }
      });

      // Récupérer le contexte actuel
      contextButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'getEditorContent' });
      });

      // Fonction d'envoi de message
      function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;

        // Afficher le message de l'utilisateur
        addMessage(text, 'user');
        
        // Envoyer au backend
        vscode.postMessage({
          command: 'sendMessage',
          text: text
        });
        
        // Réinitialiser l'input
        messageInput.value = '';
        messageInput.style.height = '40px';
      }
      
      // Gérer les clics sur les boutons d'action dans les

      // Ajouter un message au chat
      function addMessage(text, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = \`message ${sender}-message\`;
        
        // Formater le texte (markdown simple)
        let formattedText = text;
        
        // Remplacer les blocs de code
        formattedText = formattedText.replace(${blocReplacementRegexp}, '<pre><code>$1</code></pre>');
        
        // Remplacer le code inline
        formattedText = formattedText.replace(${inlineCodeReplacementRegexp}, '<code>$1</code>');
        
        // Ajouter des retours à la ligne
        formattedText = formattedText.replace(/\\n/g, '<br>');
        
        messageDiv.innerHTML = formattedText;
        chatMessages.appendChild(messageDiv);
        
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      // Gérer les messages du backend
      window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
          case 'response':
            addMessage(message.value, 'assistant');
            break;
          case 'error':
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error';
            errorDiv.textContent = message.value;
            chatMessages.appendChild(errorDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            break;
          case 'loading':
            loadingIndicator.style.display = message.value ? 'block' : 'none';
            break;
          case 'editorContent':
            const context = message.value;
            messageInput.value += \`\n\nContexte actuel:
- Fichier: ${context.fileName}
- Langage: ${context.language}
- Sélection: \${context.selection.substring(0, 50)}...\`;
            messageInput.style.height = 'auto';
            messageInput.style.height = (messageInput.scrollHeight) + 'px';
            break;
        }
      });
    }());
  </script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
