import * as vscode from 'vscode';

class XsdNodeDecorationProvider implements vscode.FileDecorationProvider {
    private occurrences = new Map<string, { min: string | null, max: string | null }>();
    private nillableNodes = new Map<string, boolean>();
    
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private constructor() {}

    static instance: XsdNodeDecorationProvider | null = null;
    static getInstance(): XsdNodeDecorationProvider {
        if (!XsdNodeDecorationProvider.instance) {
            XsdNodeDecorationProvider.instance = new XsdNodeDecorationProvider();
        }
        return XsdNodeDecorationProvider.instance;
    }
    
    updateOccurrences(uri: vscode.Uri, min: string | null, max: string | null): void {
        if (!min && !max || (min == '1' && min == max)) return;
        
        const key = uri.toString();
        this.occurrences.set(key, { 
            min: min, 
            max: max 
        });
        this._onDidChangeFileDecorations.fire(uri);
    }

    clearOccurrences(uri?: vscode.Uri): void {
        if (uri) {
            this.occurrences.delete(uri.toString());
        } else {
            this.occurrences.clear();
        }
        this._onDidChangeFileDecorations.fire(uri ?? []);
    }

    updateNillableNode(uri: vscode.Uri, isNillable: boolean): void {
        const key = uri.toString();
        if (this.nillableNodes.get(key) !== isNillable) {
            this.nillableNodes.set(key, isNillable);
            this._onDidChangeFileDecorations.fire(uri);
        }
    }

    clearNillableNodes(uri?: vscode.Uri): void {
        if (uri) {
            this.nillableNodes.delete(uri.toString());
        } else {
            this.nillableNodes.clear();
        }
        this._onDidChangeFileDecorations.fire(uri ?? []);
    }

    provideFileDecoration(
        uri: vscode.Uri,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FileDecoration> {
        const key = uri.toString();
        
        if (this.occurrences.has(key)) {
            const { min, max } = this.occurrences.get(key)!;
            const { badge, tooltip } = this.createOccurrenceDecoration(min, max);
            return {
                badge,
                tooltip
            };
        }
        if (this.nillableNodes.get(key)) {
            return this.createNillableDecoration();
        }
        return undefined;
    }


    private createOccurrenceDecoration(min: string | null, max: string | null): { badge: string, tooltip: string } {
        const tooltipParts: string[] = [];
        let minBadge = '1';
        if (min) {
            tooltipParts.push(`minOccurs: ${min}`);
            if (min != '0' && min != '1') {
                minBadge = 'N';
            } else {
                minBadge = min;
            }
        }
        let maxBadge = '1';
        if (max) {
            tooltipParts.push(`maxOccurs: ${max}`);
            if (max == 'unbounded') {
                maxBadge = '∞';
            } else if (max != '1') {
                maxBadge = 'N';
            } else {
                maxBadge = max;
            }
        }
        return {
            badge: `${minBadge}${maxBadge}`,
            tooltip: tooltipParts.join(' • ')
        };
    }

    private createNillableDecoration(): vscode.FileDecoration {
        return {
            tooltip: 'Nillable',
            color: new vscode.ThemeColor('disabledForeground'),
        };
    }
}

export const XsdDecorationProvider = XsdNodeDecorationProvider.getInstance();
