import * as vscode from 'vscode';
import { XsdOutlineProvider } from './xsdOutline';
import { XsdDecorationProvider } from './xsdNodeDecorationProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new XsdOutlineProvider(context);
    
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('xsdOutline', provider),
        vscode.window.registerFileDecorationProvider(XsdDecorationProvider), 
        vscode.commands.registerCommand('xsdOutline.openSelection', (xpath?: string) => {
            provider.focusElement(xpath);
        }),
        vscode.commands.registerCommand('xsdOutline.refresh', () => {
            provider.refresh();
        })
    );
    
    vscode.commands.executeCommand('setContext', 'xsdOutlineEnabled', false);
}

export function deactivate() {}
