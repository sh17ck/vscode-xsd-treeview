import * as vscode from 'vscode';
import * as xpath from 'xpath';
import * as xmldom from 'xmldom';
import * as path from 'path';
import * as fs from 'fs';
import { XsdDecorationProvider } from './xsdNodeDecorationProvider';

interface XsdNode {
    element: Element;
    name: string;
    type: string;
    baseType?: string;
    hasChildren: boolean;
    sourceUri?: vscode.Uri;
    xpath?: string;
}

export class XsdOutlineProvider implements vscode.TreeDataProvider<XsdNode>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<XsdNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private document: Document | undefined;
    private editor: vscode.TextEditor | undefined;
    private isXsdDocument = false;
    private importedDocuments = new Map<string, {doc: Document, uri: vscode.Uri}>();
    private importedSchemaCache = new Map<string, {doc: Document, mtimeMs: number}>();

    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.checkDocument()),
            vscode.workspace.onDidChangeTextDocument(() => this.checkDocument())
        );
        this.checkDocument();
    }

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    refresh(): void {
        this.checkDocument(true);
    }

    private async checkDocument(forceRefresh = false): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const wasXsd = this.isXsdDocument;

        if (!editor || editor.document.languageId !== 'xml') {
            this.resetState();
            if (wasXsd) {
                this._onDidChangeTreeData.fire(undefined);
                vscode.commands.executeCommand('setContext', 'xsdOutlineEnabled', false);
            }
            return;
        }

        if (forceRefresh || this.editor?.document.uri.toString() !== editor.document.uri.toString()) {
            await this.parseDocument(editor);
        }

        if (wasXsd !== this.isXsdDocument) {
            vscode.commands.executeCommand('setContext', 'xsdOutlineEnabled', this.isXsdDocument);
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    private resetState(): void {
        this.document = undefined;
        this.editor = undefined;
        this.isXsdDocument = false;
        this.importedDocuments.clear();
    }

    private async parseDocument(editor: vscode.TextEditor): Promise<void> {
        this.resetState();
        this.editor = editor;

        try {
            const text = editor.document.getText();
            this.document = new xmldom.DOMParser({locator: {}}).parseFromString(text);

            const root = this.document.documentElement;
            this.isXsdDocument = root?.nodeName.match(/^(xs:|xsd:)?schema$/i) !== null &&
                               (root.namespaceURI === 'http://www.w3.org/2001/XMLSchema' || 
                                root.hasAttribute('xmlns:xs') || 
                                root.hasAttribute('xmlns:xsd'));

            if (this.isXsdDocument) {
                await this.loadImportedSchemas(editor.document.uri);
            }
        } catch (error) {
            vscode.window.showErrorMessage('Error parsing document: ' + (error instanceof Error ? error.message : String(error)));
            console.error('Error parsing document:', error);
        }
    }

    private async loadImportedSchemas(baseUri: vscode.Uri): Promise<void> {
        if (!this.document) return;

        const importElements = this.selectElements("/*[local-name()='schema']/*[local-name()='import' or local-name()='include']");
        
        for (const importEl of importElements) {
            await this.handleImportElement(importEl, baseUri);
        }
    }

    private async handleImportElement(importEl: Element, baseUri: vscode.Uri): Promise<void> {
        const schemaLocation = importEl.getAttribute('schemaLocation');
        if (!schemaLocation) return;
        try {
            const importedUri = await this.resolveSchemaLocation(baseUri, schemaLocation);
            if (!importedUri) {
                vscode.window.showErrorMessage(`Can't find imported schema: ${schemaLocation}`);
                return;
            }
            const importedDoc = await this.loadSchemaDocumentWithCache(importedUri);
            if (importedDoc) {
                const namespace = importEl.getAttribute('namespace') || '';
                this.importedDocuments.set(namespace, {doc: importedDoc, uri: importedUri});
            } else {
                vscode.window.showErrorMessage(`Can't load imported schema: ${schemaLocation}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage('Error loading imported schema: ' + (error instanceof Error ? error.message : String(error)));
            console.error(`Error loading imported schema ${schemaLocation}:`, error);
        }
    }

    private async resolveSchemaLocation(baseUri: vscode.Uri, location: string): Promise<vscode.Uri | undefined> {
        try {
            if (!path.isAbsolute(location)) {
                const basePath = path.dirname(baseUri.fsPath);
                const fullPath = path.join(basePath, location);
                try {
                    await fs.promises.access(fullPath);
                    return vscode.Uri.file(fullPath);
                } catch {}
            }

            try {
                const uri = vscode.Uri.parse(location);
                if (uri.scheme === 'file') {
                    try {
                        await fs.promises.access(uri.fsPath);
                        return uri;
                    } catch {}
                }
            } catch {}

            const files = await vscode.workspace.findFiles(`**/${location}`);
            if (files.length > 0) {
                return files[0];
            }

            return undefined;
        } catch (error) {
            console.error('Error resolving schema location:', error);
            return undefined;
        }
    }

    private async loadSchemaDocumentWithCache(uri: vscode.Uri): Promise<Document | undefined> {
        try {
            if (uri.scheme === 'file') {
                const stat = await fs.promises.stat(uri.fsPath);
                const cached = this.importedSchemaCache.get(uri.fsPath);
                if (cached && cached.mtimeMs === stat.mtimeMs) {
                    return cached.doc;
                }
                const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
                const doc = new xmldom.DOMParser({locator: {}}).parseFromString(content);
                this.importedSchemaCache.set(uri.fsPath, {doc, mtimeMs: stat.mtimeMs});
                return doc;
            } else {
                const document = await vscode.workspace.openTextDocument(uri);
                const content = document.getText();
                const doc = new xmldom.DOMParser({locator: {}}).parseFromString(content);
                return doc;
            }
        } catch (error) {
            vscode.window.showErrorMessage('Error loading schema document: ' + (error instanceof Error ? error.message : String(error)));
            console.error('Error loading schema document:', error);
            return undefined;
        }
    }

    private selectElements(xpathExpr: string, context?: Element): Element[] {
        if (!this.document) return [];

        try {
            const select = xpath.useNamespaces({
                'xs': 'http://www.w3.org/2001/XMLSchema',
                'xsd': 'http://www.w3.org/2001/XMLSchema'
            });

            let elements: Element[] = [];
            
            const mainResult = select(xpathExpr, context || this.document);
            if (mainResult) {
                if (Array.isArray(mainResult)) {
                    elements = mainResult.filter((n): n is Element => this.isXMLElement(n));
                } else if (this.isXMLElement(mainResult)) {
                    elements = [mainResult];
                }
            }

            for (const [_, {doc}] of this.importedDocuments) {
                const importedResult = select(xpathExpr, doc);
                if (importedResult) {
                    if (Array.isArray(importedResult)) {
                        elements.push(...importedResult.filter((n): n is Element => this.isXMLElement(n)));
                    } else if (this.isXMLElement(importedResult)) {
                        elements.push(importedResult);
                    }
                }
            }

            return elements;
        } catch (error) {
            console.error('XPath error:', error);
            return [];
        }
    }

    private isXMLElement(node: any): node is Element {
        return node && typeof node === 'object' && 'nodeType' in node && node.nodeType === 1;
    }

    getTreeItem(node: XsdNode): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            node.name,
            node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        treeItem.description = '';
        
        const localName = node.element.localName || node.element.nodeName.split(':').pop() || '';
        const isNillable = node.element.getAttribute('nillable') === 'true';
        
        const nodeId = `${node.name}_${Math.random().toString(36).substr(2, 9)}`;
        const resourceUri = vscode.Uri.parse(`xsd-node:/${nodeId}`);
        treeItem.resourceUri = resourceUri;
        
        if (isNillable) {
            XsdDecorationProvider.updateNillableNode(resourceUri, true);
        }
        
        if (node.element.localName === 'element') {
            let minOccurs = node.element.getAttribute('minOccurs');
            let maxOccurs = node.element.getAttribute('maxOccurs');

            if (minOccurs || maxOccurs) {
                XsdDecorationProvider.updateOccurrences(resourceUri, minOccurs, maxOccurs);
            }
        }

        if (node.type) {
            treeItem.description += node.type;
        }

        treeItem.tooltip = this.getDocumentationText(node.element);
        if (!treeItem.tooltip) {
            treeItem.tooltip = treeItem.label as string;
        }
        
        treeItem.command = {
            command: 'xsdOutline.openSelection',
            title: 'Go to element',
            arguments: [node.xpath]
        };
        
        const typeName = node.type ? node.type.split(':').pop() : null;
        const baseType = node.baseType;
        
        const stringTypes = ['string', 'anyURI', 'dateTime', 'date', 'token', 'ID', 'IDREF', 'NCName'];
        const numericTypes = ['decimal', 'integer', 'int', 'long', 'short', 'byte', 'float', 'double'];
        
        switch (localName) {
            case 'complexType':
                treeItem.iconPath = new vscode.ThemeIcon('symbol-constructor');
                break;
            case 'simpleType':
                if (this.isEnumerationType(node.name)) {
                    treeItem.iconPath = new vscode.ThemeIcon('symbol-enum');
                } else {
                    treeItem.iconPath = new vscode.ThemeIcon('symbol-field');
                }
                break;
            case 'element':
                if (node.type && typeName) {
                    if (this.isEnumerationType(typeName)) {
                        treeItem.iconPath = new vscode.ThemeIcon('symbol-enum');
                    } 
                    else if (baseType) {
                        if (stringTypes.includes(baseType)) {
                            treeItem.iconPath = new vscode.ThemeIcon('symbol-text');
                        } else if (numericTypes.includes(baseType)) {
                            treeItem.iconPath = new vscode.ThemeIcon('symbol-number');
                        } else if (baseType === 'boolean') {
                            treeItem.iconPath = new vscode.ThemeIcon('symbol-boolean');
                        } else {
                            treeItem.iconPath = new vscode.ThemeIcon('symbol-field');
                        }
                    } else {
                        treeItem.iconPath = new vscode.ThemeIcon('symbol-field');
                    }
                } else if (this.selectElements('./*[local-name()="complexType"]', node.element).length > 0) {
                    treeItem.iconPath = new vscode.ThemeIcon('symbol-constructor');
                } else {
                    treeItem.iconPath = new vscode.ThemeIcon('symbol-field');
                }
                break;
            case 'choice':
                treeItem.iconPath = new vscode.ThemeIcon('symbol-class');
                break;
            case 'attribute':
                treeItem.iconPath = new vscode.ThemeIcon('symbol-property');
                break;
            case 'enumeration':
                treeItem.iconPath = new vscode.ThemeIcon('symbol-enum-member');
                break;
            default:
                treeItem.iconPath = new vscode.ThemeIcon('symbol-field');
        }
        
        return treeItem;
    }

    private getDocumentationText(element: Element): string | undefined {
        try {
            const annotations = this.selectElements('./*[local-name()="annotation"]', element);
            if (annotations.length === 0) return undefined;
            
            const documentations = this.selectElements('./*[local-name()="documentation"]', annotations[0]);
            if (documentations.length === 0) return undefined;
            
            let docText = '';
            for (const docElement of documentations) {
                docText += docElement.textContent || '';
            }
            
            return docText.trim();
        } catch (error) {
            console.error('Error getting documentation:', error);
            return undefined;
        }
    }
    
    getChildren(node?: XsdNode): Thenable<XsdNode[]> {
        if (!this.isXsdDocument || !this.document) {
            return Promise.resolve([]);
        }

        if (node) {
            if (!node.hasChildren) {
                return Promise.resolve([]);
            }
            return Promise.resolve(this.getChildNodes(node.element));
        } else {
            return Promise.resolve(this.getRootNodes());
        }
    }

    private getRootNodes(): XsdNode[] {
        const elements = this.selectElements("/*[local-name()='schema']/*[local-name()='element']");
        return elements.map(el => this.createNode(el));
    }

    private getChildNodes(parent: Element): XsdNode[] {
        const children: XsdNode[] = [];
        
        const localName = parent.localName || parent.nodeName.split(':').pop() || '';
        const typeName = parent.getAttribute('type');
        
        if (localName === 'element') {
            const inlineComplexTypes = this.selectElements("./*[local-name()='complexType']", parent);
            if (inlineComplexTypes.length > 0) {
                children.push(...this.getTypeChildren(inlineComplexTypes[0]));
                
                if (children.length > 0) {
                    return children;
                }
            }
        }
        
        if (localName === 'element' && typeName) {
            const typeNameWithoutPrefix = typeName.split(':').pop() || '';
            if (this.isEnumerationType(typeNameWithoutPrefix)) {
                const simpleTypes = this.selectElements(`//*[local-name()='simpleType'][@name='${typeNameWithoutPrefix}']`);
                if (simpleTypes.length > 0) {
                    const enumerations = this.selectElements(
                        `./*[local-name()='restriction']/*[local-name()='enumeration']`, 
                        simpleTypes[0]
                    );
                    
                    for (const enumElement of enumerations) {
                        const value = enumElement.getAttribute('value') || '';
                        children.push({
                            element: enumElement,
                            name: value,
                            type: '',
                            hasChildren: false,
                            sourceUri: this.editor?.document.uri,
                            xpath: this.generateXPathForElement(enumElement)
                        });
                    }
                    
                    if (children.length > 0) {
                        return children;
                    }
                }
            }
        }
        
        if (typeName) {
            const typeElements = this.selectElements(`//*[local-name()='complexType'][@name='${typeName.split(':').pop()}']`);
            if (typeElements.length > 0) {
                children.push(...this.getTypeChildren(typeElements[0]));
            }
        }
        
        const directChildren = this.selectElements("./*", parent);
        directChildren.forEach(child => {
            const localName = child.localName || child.nodeName.split(':').pop() || '';
            
            if (localName === 'element') {
                children.push(this.createNode(child));
            } 
            else if (localName === 'choice') {
                children.push(this.createChoiceNode(child));
            }
            else if (localName === 'sequence' || localName === 'all') {
                const nestedElements = this.selectElements("./*[local-name()='element' or local-name()='choice']", child);
                nestedElements.forEach(el => {
                    const nestedLocalName = el.localName || el.nodeName.split(':').pop() || '';
                    if (nestedLocalName === 'element') {
                        children.push(this.createNode(el));
                    } else if (nestedLocalName === 'choice') {
                        children.push(this.createChoiceNode(el));
                    }
                });
            }
            else if (localName === 'complexType') {
                children.push(...this.getTypeChildren(child));
            }
        });
        
        return children;
    }

    private resolveBaseType(typeName: string): string | undefined {
        if (!typeName) return undefined;
        
        const typeNameWithoutPrefix = typeName.split(':').pop() || '';
        
        const builtInTypes = [
            'string', 'anyURI', 'dateTime', 'date', 'token', 'ID', 'IDREF', 'NCName',
            'decimal', 'integer', 'int', 'long', 'short', 'byte', 'float', 'double',
            'boolean'
        ];
        
        if (builtInTypes.includes(typeNameWithoutPrefix)) {
            return typeNameWithoutPrefix;
        }
        
        const simpleTypes = this.selectElements(`//*[local-name()='simpleType'][@name='${typeNameWithoutPrefix}']`);
        
        if (simpleTypes.length > 0) {
            const restrictions = this.selectElements(`./*[local-name()='restriction']`, simpleTypes[0]);
            if (restrictions.length > 0) {
                const baseType = restrictions[0].getAttribute('base');
                if (baseType) {
                    return this.resolveBaseType(baseType);
                }
            }
        }
        
        return typeNameWithoutPrefix; }

    private isEnumerationType(typeName: string): boolean {
        if (!typeName) return false;
        
        const typeNameWithoutPrefix = typeName.split(':').pop() || '';
        
        const simpleTypes = this.selectElements(`//*[local-name()='simpleType'][@name='${typeNameWithoutPrefix}']`);
        
        if (simpleTypes.length > 0) {
            const enumerations = this.selectElements(
                `./*[local-name()='restriction']/*[local-name()='enumeration']`, 
                simpleTypes[0]
            );
            return enumerations.length > 0;
        }
        
        return false;
    }    

    private getTypeChildren(complexType: Element): XsdNode[] {
        const children: XsdNode[] = [];
        
        const extensions = this.selectElements("./*[local-name()='complexContent']/*[local-name()='extension']", complexType);
        for (const extension of extensions) {
            const baseType = extension.getAttribute('base');
            if (baseType) {
                const baseTypeName = baseType.split(':').pop() || '';
                const baseTypeElements = this.selectElements(`//*[local-name()='complexType'][@name='${baseTypeName}']`);
                if (baseTypeElements.length > 0) {
                    children.push(...this.getTypeChildren(baseTypeElements[0]));
                }
            }
            
            const extensionGroups = this.selectElements("./*[local-name()='sequence' or local-name()='choice' or local-name()='all']", extension);
            for (const group of extensionGroups) {
                const elements = this.selectElements("./*[local-name()='element' or local-name()='choice']", group);
                for (const el of elements) {
                    const localName = el.localName || el.nodeName.split(':').pop() || '';
                    if (localName === 'element') {
                        children.push(this.createNode(el));
                    } else if (localName === 'choice') {
                        children.push(this.createChoiceNode(el));
                    }
                }
            }
        }
        
        const groups = this.selectElements("./*[local-name()='sequence' or local-name()='choice' or local-name()='all']", complexType);
        groups.forEach(group => {
            const groupType = group.localName || group.nodeName.split(':').pop() || '';
            
            if (groupType === 'choice') {
                children.push(this.createChoiceNode(group));
            } else {
                const elements = this.selectElements("./*[local-name()='element' or local-name()='choice']", group);
                elements.forEach(el => {
                    const localName = el.localName || el.nodeName.split(':').pop() || '';
                    if (localName === 'element') {
                        children.push(this.createNode(el));
                    } else if (localName === 'choice') {
                        children.push(this.createChoiceNode(el));
                    }
                });
            }
        });
        
        const directElements = this.selectElements("./*[local-name()='element' or local-name()='choice']", complexType);
        directElements.forEach(el => {
            const localName = el.localName || el.nodeName.split(':').pop() || '';
            if (localName === 'element') {
                children.push(this.createNode(el));
            } else if (localName === 'choice') {
                children.push(this.createChoiceNode(el));
            }
        });
        
        return children;
    }

    private createChoiceNode(choiceElement: Element): XsdNode {
        const hasChildren = this.selectElements("./*[local-name()='element']", choiceElement).length > 0;
        
        return {
            element: choiceElement,
            name: '<choice>',
            type: '',
            hasChildren: hasChildren,
            sourceUri: this.editor?.document.uri
        };
    }

    private createNode(element: Element): XsdNode {
        const name = element.getAttribute('name') || '';
        const type = element.getAttribute('type') || '';
        const baseType = type ? this.resolveBaseType(type) : undefined;
        
        let sourceUri = this.editor?.document.uri;
        
        if (this.document && element.ownerDocument !== this.document) {
            for (const [namespace, {doc, uri}] of this.importedDocuments.entries()) {
                if (element.ownerDocument === doc) {
                    sourceUri = uri;
                    break;
                }
            }
        }
        
        const xpath = this.generateXPathForElement(element);
        
        const hasTypeChildren = type ? 
            this.selectElements(`//*[local-name()='complexType'][@name='${type.split(':').pop()}']/*[local-name()='sequence' or local-name()='choice' or local-name()='all']/*[local-name()='element']`).length > 0 : 
            false;
            
        const hasDirectChildren = this.selectElements("./*[local-name()='element']", element).length > 0 ||
            this.selectElements("./*[local-name()='complexType']/*[local-name()='sequence' or local-name()='choice' or local-name()='all']/*[local-name()='element']", element).length > 0;
        
        const hasExtensionChildren = type ? 
            this.selectElements(`//*[local-name()='complexType'][@name='${type.split(':').pop()}']/*[local-name()='complexContent']/*[local-name()='extension']`).length > 0 : 
            false;
        
        const isEnum = this.isEnumerationType(type);
        const hasChildren = hasTypeChildren || hasDirectChildren || hasExtensionChildren || isEnum;
        
        return {
            element,
            name,
            type,
            baseType,
            hasChildren,
            sourceUri,
            xpath
        };
    }

    private generateXPathForElement(element: Element): string {
        const localName = element.localName || element.nodeName.split(':').pop() || '';
        const name = element.getAttribute('name');
        
        if (localName === 'enumeration') {
            const value = element.getAttribute('value');
            let parent = element.parentNode;
            while (parent && (parent as Element).localName !== 'simpleType') {
                parent = parent.parentNode;
            }
            if (parent && (parent as Element).getAttribute) {
                const simpleTypeName = (parent as Element).getAttribute('name');
                if (simpleTypeName) {
                    return `//*[local-name()='simpleType'][@name='${simpleTypeName}']//enumeration[@value='${value}']`;
                }
            }
            return `//enumeration[@value='${value}']`;
        }
        
        let parent = element.parentNode;
        if (!parent || parent.nodeType !== 1) {
            return `//*[local-name()='${localName}']${name ? `[@name='${name}']` : ''}`;
        }
        
        const parentEl = parent as Element;
        const parentLocalName = parentEl.localName || parentEl.nodeName.split(':').pop() || '';
        const parentName = parentEl.getAttribute('name');
        
        let xpath = '';
        
        if (parentName) {
            xpath = `//*[local-name()='${parentLocalName}'][@name='${parentName}']`;
        } else {
            let grandparent = parent.parentNode;
            if (grandparent && grandparent.nodeType === 1) {
                const grandparentEl = grandparent as Element;
                const grandparentLocalName = grandparentEl.localName || grandparentEl.nodeName.split(':').pop() || '';
                const grandparentName = grandparentEl.getAttribute('name');
                
                if (grandparentName) {
                    xpath = `//*[local-name()='${grandparentLocalName}'][@name='${grandparentName}']/*[local-name()='${parentLocalName}']`;
                } else {
                    xpath = `//*[local-name()='${parentLocalName}']`;
                }
            } else {
                xpath = `//*[local-name()='${parentLocalName}']`;
            }
        }
        
        xpath += `/*[local-name()='${localName}']${name ? `[@name='${name}']` : ''}`;
        
        return xpath;
    }

    public async focusElement(elementXpath?: string): Promise<boolean> {
        if (!this.document || !this.editor) {
            return false;
        }
        
        let targetElement: Element | null = null;
        let sourceUri = this.editor.document.uri;
        
        if (elementXpath) {
            try {
                const select = xpath.useNamespaces({
                    'xs': 'http://www.w3.org/2001/XMLSchema',
                    'xsd': 'http://www.w3.org/2001/XMLSchema'
                });
                
                let result = select(elementXpath, this.document);
                if (result) {
                    if (Array.isArray(result) && result.length > 0 && this.isXMLElement(result[0])) {
                        targetElement = result[0];
                    } else if (this.isXMLElement(result)) {
                        targetElement = result;
                    }
                }
                
                if (!targetElement) {
                    for (const [_, {doc, uri}] of this.importedDocuments) {
                        result = select(elementXpath, doc);
                        if (result) {
                            if (Array.isArray(result) && result.length > 0 && this.isXMLElement(result[0])) {
                                targetElement = result[0];
                                sourceUri = uri;
                                break;
                            } else if (this.isXMLElement(result)) {
                                targetElement = result;
                                sourceUri = uri;
                                break;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('XPath search error:', error);
            }
        }
        
        if (!targetElement) {
            return false;
        }
        
        try {
            const document = await vscode.workspace.openTextDocument(sourceUri);
            const editor = await vscode.window.showTextDocument(document);
            
            const lineNumber = (targetElement as any).lineNumber ? ((targetElement as any).lineNumber - 1) : 0;
            
            const position = new vscode.Position(lineNumber, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
            return true;
        } catch (error) {
            console.error('Error focusing element:', error);
            return false;
        }
    }
}
