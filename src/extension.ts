import * as vscode from 'vscode';
import { XsdOutlineProvider } from './xsdOutline';
import { XsdDecorationProvider } from './xsdNodeDecorationProvider';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('XSD Outline');
    context.subscriptions.push(outputChannel);

    const provider = new XsdOutlineProvider(outputChannel);
    
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('xsdOutline', provider),
        vscode.window.registerFileDecorationProvider(XsdDecorationProvider),
        vscode.commands.registerCommand('xsdOutline.openSelection', (xpath?: string) => {
            provider.focusElement(xpath);
        }),
        vscode.commands.registerCommand('xsdOutline.refresh', () => {
            provider.refresh();
        }),
        vscode.commands.registerCommand('xsdOutline.collapseAll', () => {
            provider.collapseAll();
        }),
        vscode.commands.registerCommand('xsdOutline.copyName', async (element?: { name?: string }) => {
            const name = element?.name ?? '';
            await vscode.env.clipboard.writeText(name);
        })
    );
    
    vscode.commands.executeCommand('setContext', 'xsdOutlineEnabled', false);

    const treeView = vscode.window.createTreeView('xsdOutline', {
        treeDataProvider: provider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    treeView.onDidChangeVisibility(e => {
        vscode.commands.executeCommand('setContext', 'xsdOutlineActive', e.visible);
    });
}

export function deactivate() {}
