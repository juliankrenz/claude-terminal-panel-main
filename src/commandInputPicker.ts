import * as vscode from 'vscode';
import { HelpExecutor } from './helpExecutor';
import { PathAutocompleteProvider } from './pathAutocompleteProvider';
import { CommandFlag, PathContext, PathFilterMode, PathSuggestion } from './types';

interface CommandQuickPickItem extends vscode.QuickPickItem {
  flag?: CommandFlag;
  isRunCommand?: boolean;
  pathSuggestion?: PathSuggestion;
}

// Value hints that indicate path completion
const PATH_HINTS = new Set([
  '<path>',
  'PATH',
  '[path]',
  '<file>',
  'FILE',
  '[file]',
  '<directory>',
  'DIRECTORY',
  '<dir>',
  'DIR',
  '[directory]',
  '[dir]'
]);

const DIRECTORY_HINTS = new Set([
  '<directory>',
  'DIRECTORY',
  '<dir>',
  'DIR',
  '[directory]',
  '[dir]'
]);

const FILE_HINTS = new Set(['<file>', 'FILE', '[file]']);

function isPathValueHint(hint: string | undefined): boolean {
  if (!hint) return false;
  const normalized = hint.trim();
  // Match plurals: paths, files, dirs, directories
  return (
    PATH_HINTS.has(normalized) || /\b(paths?|files?|dirs?|director(y|ies)?)\b/i.test(normalized)
  );
}

function getFilterMode(hint: string | undefined): PathFilterMode {
  if (!hint) return 'all';
  const normalized = hint.trim();
  // Check exact matches first
  if (DIRECTORY_HINTS.has(normalized)) return 'directories';
  if (FILE_HINTS.has(normalized)) return 'files';
  // Fall back to regex for variations like <directories...>
  if (/\b(dirs?|director(y|ies)?)\b/i.test(normalized)) return 'directories';
  if (/\bfiles?\b/i.test(normalized)) return 'files';
  return 'all';
}

export interface CommandInputResult {
  command: string;
  args: string[];
  cancelled: boolean;
}

export class CommandInputPicker {
  private helpExecutor: HelpExecutor;
  private pathProvider: PathAutocompleteProvider;

  constructor() {
    this.helpExecutor = new HelpExecutor({
      debounceMs: 300,
      timeout: 5000,
      cacheMaxAge: 5 * 60 * 1000
    });
    this.pathProvider = new PathAutocompleteProvider({
      debounceMs: 100,
      maxResults: 15
    });
  }

  async promptForCommand(defaultValue: string): Promise<CommandInputResult> {
    return new Promise((resolve) => {
      const quickPick = vscode.window.createQuickPick<CommandQuickPickItem>();
      quickPick.title = 'Enter Command with Arguments';
      quickPick.placeholder = 'Type command name, then select flags...';
      quickPick.value = defaultValue;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;

      let currentCommand = '';
      let availableFlags: CommandFlag[] = [];
      let currentPathSuggestions: PathSuggestion[] = [];
      let currentPathContext: PathContext | null = null;

      const parseInput = (
        value: string
      ): { command: string; existingArgs: string[]; partial: string } => {
        const parts = value.trim().split(/\s+/);
        const command = parts[0] || '';
        const allArgs = parts.slice(1);
        // Check if user is typing a partial flag
        const lastPart = allArgs[allArgs.length - 1] || '';
        const isPartial = lastPart.startsWith('-') && !lastPart.includes('=');
        return {
          command,
          existingArgs: isPartial ? allArgs.slice(0, -1) : allArgs,
          partial: isPartial ? lastPart : ''
        };
      };

      /**
       * Detects if user is typing a path value for a flag.
       */
      const detectPathContext = (value: string, flags: CommandFlag[]): PathContext | null => {
        const parts = value.trim().split(/\s+/);
        if (parts.length < 2) return null;

        // Check if input ends with whitespace (path input may be complete)
        const endsWithSpace = /\s$/.test(value);

        // Check if the last part is a flag that takes a path value (with trailing space)
        // This handles cases like "command --flag ", "command arg --flag ", etc.
        if (endsWithSpace && parts.length >= 2) {
          const lastPart = parts[parts.length - 1];
          if (lastPart.startsWith('-')) {
            const flag = flags.find((f) => f.flag === lastPart || f.shortFlag === lastPart);
            if (flag?.takesValue && isPathValueHint(flag.valueHint)) {
              return {
                active: true,
                partialPath: '',
                filterMode: getFilterMode(flag.valueHint),
                isAbsolute: false,
                flag
              };
            }
          }
        }

        // Look backwards for the last flag that takes a path value
        for (let i = parts.length - 2; i >= 1; i--) {
          const part = parts[i];
          if (!part.startsWith('-')) continue;

          // Find matching flag
          const flag = flags.find((f) => f.flag === part || f.shortFlag === part);

          if (flag?.takesValue && isPathValueHint(flag.valueHint)) {
            // Check if there's a value being typed after this flag
            const valueIndex = i + 1;
            if (valueIndex < parts.length) {
              const partialPath = parts[valueIndex];

              // Don't trigger if the value looks like another flag
              if (partialPath.startsWith('-')) return null;

              // If input ends with space, user is done with path input
              if (endsWithSpace) {
                return null;
              }

              // If there's anything after the path value, path input is complete
              if (valueIndex < parts.length - 1) {
                return null;
              }

              return {
                active: true,
                partialPath,
                filterMode: getFilterMode(flag.valueHint),
                isAbsolute: partialPath.startsWith('/') || partialPath.startsWith('~'),
                flag
              };
            }

            // Flag exists but no value yet - show empty path completion
            return {
              active: true,
              partialPath: '',
              filterMode: getFilterMode(flag.valueHint),
              isAbsolute: false,
              flag
            };
          }
        }

        return null;
      };

      const buildItems = (
        flags: CommandFlag[],
        partial: string,
        existingArgs: string[],
        pathSuggestions: PathSuggestion[],
        pathContext: PathContext | null
      ): CommandQuickPickItem[] => {
        const items: CommandQuickPickItem[] = [];
        const currentValue = quickPick.value.trim();

        // Always show "run current command" option at top
        if (currentValue) {
          items.push({
            label: `$(play) Run: ${currentValue}`,
            description: 'Press Enter to execute this command',
            isRunCommand: true,
            alwaysShow: true
          });
        }

        // If in path mode, show path suggestions
        if (pathContext?.active && pathSuggestions.length > 0) {
          items.push({
            label: '$(folder) Path suggestions',
            kind: vscode.QuickPickItemKind.Separator,
            alwaysShow: true
          });

          for (const suggestion of pathSuggestions) {
            const icon = suggestion.isDirectory ? '$(folder)' : '$(file)';
            items.push({
              label: `${icon} ${suggestion.name}`,
              description: suggestion.path,
              detail: suggestion.isDirectory ? 'Directory' : 'File',
              pathSuggestion: suggestion,
              alwaysShow: true
            });
          }

          // Add separator before flags if we have any to show
          if (flags.length > 0) {
            items.push({
              label: '$(symbol-property) Available flags',
              kind: vscode.QuickPickItemKind.Separator,
              alwaysShow: true
            });
          }
        }

        // Filter flags that haven't been used and match partial input
        const usedFlags = new Set(existingArgs.filter((a) => a.startsWith('-')));
        const filteredFlags = flags.filter((f) => {
          // Skip already used flags (unless they're repeatable)
          if (!f.repeatable) {
            if (usedFlags.has(f.flag)) return false;
            if (f.shortFlag && usedFlags.has(f.shortFlag)) return false;
          }

          // Filter by partial input
          if (partial) {
            const lowerPartial = partial.toLowerCase();
            return (
              f.flag.toLowerCase().includes(lowerPartial) ||
              (f.shortFlag?.toLowerCase().includes(lowerPartial) ?? false)
            );
          }
          return true;
        });

        // Add flag suggestions (alwaysShow bypasses QuickPick's built-in filter)
        for (const flag of filteredFlags) {
          const label = flag.shortFlag ? `${flag.shortFlag}, ${flag.flag}` : flag.flag;
          items.push({
            label: label + (flag.valueHint ? ` ${flag.valueHint}` : ''),
            description: flag.description,
            detail: flag.takesValue ? '(requires value)' : undefined,
            flag,
            alwaysShow: true
          });
        }

        // Show message if no flags available and not in path mode
        if (flags.length === 0 && currentValue && !pathContext?.active) {
          items.push({
            label: '$(info) No flag suggestions available',
            description: 'Type your command and press Enter to run',
            alwaysShow: true
          });
        }

        return items;
      };

      // Handle input changes with debounced help fetching
      quickPick.onDidChangeValue((value) => {
        const { command, existingArgs, partial } = parseInput(value);

        // Detect path context
        currentPathContext = detectPathContext(value, availableFlags);

        if (currentPathContext?.active) {
          // In path mode - fetch path suggestions
          this.pathProvider.getDebouncedSuggestions(
            currentPathContext.partialPath,
            currentPathContext.filterMode,
            currentPathContext.isAbsolute,
            (suggestions) => {
              // Guard against disposed quickPick
              try {
                // Access a property to check if quickPick is still valid
                void quickPick.value;
              } catch {
                return; // QuickPick was disposed
              }
              currentPathSuggestions = suggestions;
              const { existingArgs: args, partial: p } = parseInput(quickPick.value);
              quickPick.items = buildItems(
                availableFlags,
                p,
                args,
                currentPathSuggestions,
                currentPathContext
              );
            }
          );
        } else {
          // Not in path mode - clear path suggestions
          currentPathSuggestions = [];
        }

        // If command changed, fetch new help
        if (command && command !== currentCommand) {
          currentCommand = command;
          quickPick.busy = true;

          this.helpExecutor.getDebouncedHelp(command, (result) => {
            availableFlags = result.flags;
            const { existingArgs: args, partial: p } = parseInput(quickPick.value);
            currentPathContext = detectPathContext(quickPick.value, availableFlags);
            quickPick.items = buildItems(
              availableFlags,
              p,
              args,
              currentPathSuggestions,
              currentPathContext
            );
            quickPick.busy = false;
          });
        } else if (command === currentCommand) {
          // Same command, just update filtering
          quickPick.items = buildItems(
            availableFlags,
            partial,
            existingArgs,
            currentPathSuggestions,
            currentPathContext
          );
        }
      });

      // Handle item selection
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];

        if (quickPick.selectedItems.length === 0 || selected.isRunCommand) {
          // User pressed enter - execute command
          const parts = quickPick.value.trim().split(/\s+/);
          resolve({
            command: parts[0] || '',
            args: parts.slice(1),
            cancelled: false
          });
          quickPick.dispose();
          return;
        }

        // Handle path selection
        if (selected.pathSuggestion) {
          const suggestion = selected.pathSuggestion;
          let newValue = quickPick.value.trim();

          // Replace the partial path with the selected path
          if (currentPathContext?.active) {
            if (currentPathContext.partialPath) {
              // User was typing a partial path - replace it
              const parts = newValue.split(/\s+/);
              if (parts.length > 1) {
                parts[parts.length - 1] = suggestion.path;
                newValue = parts.join(' ');
              }
            } else {
              // No partial path (trailing space after flag) - append the path
              newValue = newValue + ' ' + suggestion.path;
            }

            // If it's a file, add a trailing space for next argument
            if (!suggestion.isDirectory) {
              newValue += ' ';
            }
          }

          quickPick.value = newValue;
          return;
        }

        if (selected.flag) {
          // Append flag to current value
          const flag = selected.flag;
          let newValue = quickPick.value.trim();

          // Remove any partial flag being typed
          const parts = newValue.split(/\s+/);
          if (parts.length > 1) {
            const lastPart = parts[parts.length - 1];
            if (lastPart.startsWith('-') && !lastPart.includes('=')) {
              parts.pop();
              newValue = parts.join(' ');
            }
          }

          // Add the selected flag with trailing space
          newValue = newValue + (newValue ? ' ' : '') + flag.flag + ' ';

          quickPick.value = newValue;
          // Keep picker open for more flag selection
        }
      });

      // Handle dismissal
      quickPick.onDidHide(() => {
        resolve({
          command: '',
          args: [],
          cancelled: true
        });
        quickPick.dispose();
      });

      // Initial load if default value has a command
      if (defaultValue) {
        const { command, existingArgs, partial } = parseInput(defaultValue);
        if (command) {
          currentCommand = command;
          quickPick.busy = true;
          void this.helpExecutor.getHelp(command).then((result) => {
            availableFlags = result.flags;
            currentPathContext = detectPathContext(defaultValue, availableFlags);
            quickPick.items = buildItems(
              availableFlags,
              partial,
              existingArgs,
              currentPathSuggestions,
              currentPathContext
            );
            quickPick.busy = false;
          });
        }
      }

      quickPick.show();
    });
  }

  preloadCommands(commands: string[]): void {
    this.helpExecutor.preloadCommonCommands(commands);
  }

  dispose(): void {
    this.helpExecutor.dispose();
    this.pathProvider.dispose();
  }
}
