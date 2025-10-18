# CodeMirror Decoration Implementation Comparison

Comparison between **obsidian-fast-text-color** and **WritersRoom** plugins.

---

## Architecture Overview

### Fast Text Color
**Purpose**: Apply colored text formatting with custom syntax `~={id}text=~`

**Architecture**:
1. **Custom Parser** (Lezer grammar) - parses the custom syntax
2. **StateField** (`textColorParserField`) - maintains parse tree
3. **ViewPlugin** (`textColorViewPlugin`) - builds decorations from parse tree
4. **PostProcessor** - handles reading mode
5. **Settings Facet** - reactive settings updates

### WritersRoom
**Purpose**: Highlight lines with edits from AI feedback

**Architecture**:
1. **Edit Parser** (TypeScript) - parses JSON edit payloads
2. **StateField** (`writersRoomEditorHighlightsField`) - holds decorations
3. **StateEffect** (`setEditorHighlightsEffect`) - applies decorations via dispatch
4. **Manual Dispatch** - plugin manually dispatches effects when needed
5. **PostProcessor** - handles reading mode

---

## Key Architectural Differences

### 1. **Parser Integration**

**Fast Text Color** ✅ BETTER APPROACH:
```typescript
// Uses Lezer parser integrated with CodeMirror
const textColorParserField = StateField.define({
  create(state) {
    const parsedTree = textColorLanguage.parser.parse(state.doc.toString());
    return { tree: parsedTree, fragment: TreeFragment.addTree(parsedTree) }
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    
    // Incremental parsing - only reparse changed ranges
    const changed_ranges: ChangedRange[] = [];
    transaction.changes.iterChangedRanges((from, to, fromB, toB) =>
      changed_ranges.push({fromA: from, toA: to, fromB: fromB, toB: toB})
    );
    
    let fragments = TreeFragment.applyChanges(value.fragment, changed_ranges);
    const tree = textColorLanguage.parser.parse(new DocInput(transaction.state.doc), fragments);
    fragments = TreeFragment.addTree(tree, fragments);
    
    return {tree: tree, fragment: fragments}
  }
})
```

**WritersRoom** ❌ LIMITED:
- No parser integration with CodeMirror
- Relies on external JSON data
- No incremental updates when document changes
- Manual refresh required

**Takeaway**: Fast Text Color's approach is superior for text-based patterns. We could benefit from:
- Incremental parsing if we wanted to parse edit markers in the document itself
- Automatic updates on document changes
- BUT: Our use case (external JSON) doesn't need this complexity

---

### 2. **ViewPlugin vs Manual Dispatch**

**Fast Text Color** ✅ REACTIVE:
```typescript
class TextColorViewPlugin implements PluginValue {
  decorations: DecorationSet;
  
  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);
  }
  
  update(update: ViewUpdate) {
    if (!isLivePreview(update.state)) {
      this.decorations = new RangeSetBuilder<Decoration>().finish();
      return;
    }
    
    const selectionChanged = update.selectionSet && !update.view.plugin(livePreviewState)?.mousedown;
    
    // Automatically rebuild on changes
    if (update.docChanged || update.viewportChanged || selectionChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }
  
  buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    
    // Only process visible ranges for performance
    for (let { from, to } of view.visibleRanges) {
      view.state.field(textColorParserField).tree.iterate({
        from, to,
        enter(node) {
          // Build decorations from syntax tree
        }
      });
    }
    
    return builder.finish();
  }
}

export const textColorViewPlugin = ViewPlugin.fromClass(
  TextColorViewPlugin,
  { decorations: (value) => value.decorations }
);
```

**WritersRoom** ⚠️ MANUAL:
```typescript
// StateField holds decorations but doesn't auto-update
export const writersRoomEditorHighlightsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    let decorations = value.map(transaction.changes); // Map to changes
    for (const effect of transaction.effects) {
      if (effect.is(setEditorHighlightsEffect)) {
        decorations = buildEditorHighlightDecorations(transaction.state.doc, effect.value);
      }
    }
    return decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  }
});

// Plugin must manually dispatch updates
private dispatchEditorHighlights(editorView: EditorView, specs: EditorHighlightSpec[]): void {
  editorView.dispatch({
    effects: [setEditorHighlightsEffect.of(specs)]
  });
}
```

**Takeaway**: 
- **Fast Text Color**: Decorations automatically rebuild on doc/viewport/selection changes
- **WritersRoom**: Must manually dispatch when external data changes
- For our use case (external JSON updates), manual dispatch is actually appropriate
- BUT we could benefit from ViewPlugin's automatic viewport optimization

---

### 3. **Decoration Types**

**Fast Text Color** 🎯 MULTIPLE TYPES:
```typescript
// 1. Replace decorations for delimiters (hide syntax)
builder.add(node.from + from, node.to + from, 
  Decoration.replace({ widget: new MarkerWidget(), block: false })
);

// 2. Mark decorations for colored text (inline styling)
builder.add(node.from + from, node.to + from, 
  Decoration.mark({ class: `ftc-theme-${themeName}-${colorId}` })
);

// 3. Widget decorations for interactive elements
builder.add(node.from + from, node.to + from, 
  Decoration.replace({ 
    widget: new ColorWidget(color, from, to, expressionTo, themeName), 
    block: false 
  })
);
```

**WritersRoom** ⚠️ LINE ONLY:
```typescript
// Only line decorations
const decoration = Decoration.line({
  class: spec.className,
  attributes: spec.attributes
});

builder.add(spec.from, spec.from, decoration); // Note: from, from (same position)
```

**Takeaway**: We're limiting ourselves to line decorations when we could use:
- `Decoration.mark()` for inline text styling (better for specific text ranges)
- `Decoration.widget()` for interactive elements (buttons, icons)
- `Decoration.replace()` to hide/replace text

---

### 4. **Interactive Widgets**

**Fast Text Color** ✅ SOPHISTICATED:
```typescript
export class ColorWidget extends WidgetType {
  id: string;
  from: number;
  to: number;
  expressionTo: number;
  themeName: string;
  menu: Menu | null;
  
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("span");
    div.addClass(`ftc-theme-${this.themeName}-${this.id}`);
    div.addClass("ftc-color-delimiter");
    div.innerText = "⬤";
    
    // Click handler - select the color id range
    div.onclick = (event) => {
      view.dispatch({
        selection: { anchor: this.from, head: this.to }
      });
    };
    
    // Hover handler - show menu to change color
    div.onmouseover = (event) => {
      if (this.menu != null) return;
      
      this.menu = new Menu();
      getColors(settings).forEach(tColor => {
        this.menu!.addItem(item => {
          item.setTitle(tColor.id)
            .onClick(evt => {
              view.dispatch({
                changes: { from: this.from, to: this.to, insert: tColor.id }
              });
            });
        });
      });
      
      this.menu.addItem(item => {
        item.setTitle("Remove")
          .onClick(evt => {
            view.dispatch({
              changes: [
                { from: this.from - 3, to: this.to + 1, insert: '' },
                { from: this.expressionTo - 2, to: this.expressionTo, insert: '' }
              ]
            });
          });
      });
      
      const rect = div.getBoundingClientRect();
      this.menu.showAtPosition({ x: rect.left, y: rect.bottom });
    };
    
    return div;
  }
}
```

**WritersRoom** ❌ NO WIDGETS:
- No interactive elements in editor
- All interactivity is in sidebar
- Line decorations only provide visual styling + click handlers via attributes

**Takeaway**: We could add widgets for:
- Accept/reject buttons inline
- Edit type badges
- Preview of suggested changes
- Quick action menus

---

### 5. **Performance Optimizations**

**Fast Text Color** ✅ OPTIMIZED:
```typescript
// Only process visible ranges
buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  
  for (let { from, to } of view.visibleRanges) {  // KEY: Only visible
    view.state.field(textColorParserField).tree.iterate({
      from, to,
      enter(node) {
        // Process only visible nodes
      }
    });
  }
  
  return builder.finish();
}

// Check if in live preview mode
if (!isLivePreview(update.state)) {
  this.decorations = new RangeSetBuilder<Decoration>().finish();
  return;
}
```

**WritersRoom** ⚠️ PROCESSES ALL:
```typescript
private buildEditorHighlightSpecs(
  editorView: EditorView,
  payload: EditPayload,
  sourcePath: string,
  activeAnchorId: string | null
): EditorHighlightSpec[] {
  const specs: EditorHighlightSpec[] = [];
  
  // Processes ALL edits, regardless of viewport
  payload.edits.forEach((edit, index) => {
    const lineNumber = Math.max(1, edit.line);
    // ... build spec for every edit
  });
  
  return specs;
}
```

**Takeaway**: We should:
1. Only build decorations for visible viewport
2. Check if in live preview mode before applying
3. Cache specs that don't change

---

### 6. **Settings Management**

**Fast Text Color** ✅ REACTIVE FACET:
```typescript
// Settings facet for reactive updates
import { Facet } from "@codemirror/state";

export const settingsFacet = Facet.define<FastTextColorPluginSettings, FastTextColorPluginSettings>({
  combine: (values) => values[0]
});

// In plugin
this.settingsCompartment = new Compartment();
this.settingsExtension = this.settingsCompartment.of(settingsFacet.of(this.settings));
this.registerEditorExtension(this.settingsExtension);

// When settings change
async saveSettings() {
  await this.saveData(this.settings);
  
  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
  const editorView = (view?.editor as any)?.cm as EditorView;
  
  if (editorView == null) return;
  
  // Reconfigure the facet - triggers ViewPlugin update
  editorView.dispatch({
    effects: this.settingsCompartment.reconfigure(settingsFacet.of(this.settings))
  });
}

// Access in ViewPlugin
const settings = view.state.facet(settingsFacet);
```

**WritersRoom** ❌ NO FACET:
- Settings stored in plugin class
- No reactive updates to editor extensions
- Must manually refresh highlights on settings change

**Takeaway**: We should use a facet for:
- Highlight colors/styles
- Enable/disable features
- Active edit types to show
- Reactive updates without manual refresh

---

## Recommendations for WritersRoom

### 🎯 High Priority (Should Steal)

#### 1. **Use Decoration.mark() instead of Decoration.line()**
```typescript
// Current (line-level)
const decoration = Decoration.line({
  class: spec.className,
  attributes: spec.attributes
});
builder.add(spec.from, spec.from, decoration);

// Better (inline mark)
const decoration = Decoration.mark({
  class: spec.className,
  attributes: spec.attributes
});
builder.add(lineInfo.from, lineInfo.to, decoration);
```

**Benefits**:
- Highlights actual text content, not just line background
- Better visual clarity
- Can target specific text ranges within a line
- Standard approach for inline styling

#### 2. **Add ViewPlugin for Viewport Optimization**
```typescript
class WritersRoomViewPlugin implements PluginValue {
  decorations: DecorationSet;
  
  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);
  }
  
  update(update: ViewUpdate) {
    // Only rebuild if viewport changed or we dispatched new highlights
    if (update.viewportChanged || hasHighlightEffect(update.transactions)) {
      this.decorations = this.buildDecorations(update.view);
    }
  }
  
  buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const highlights = view.state.field(writersRoomEditorHighlightsField);
    
    // Only show decorations in visible viewport
    for (let { from, to } of view.visibleRanges) {
      highlights.between(from, to, (from, to, decoration) => {
        builder.add(from, to, decoration);
      });
    }
    
    return builder.finish();
  }
}
```

**Benefits**:
- Only renders visible highlights
- Better performance for large documents
- Automatic updates on viewport scroll

#### 3. **Add Interactive Widgets**
```typescript
class EditActionWidget extends WidgetType {
  edit: EditEntry;
  anchorId: string;
  
  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("span");
    container.addClass("writersroom-edit-actions");
    
    // Accept button
    const acceptBtn = container.createEl("button", {
      text: "✓",
      cls: "writersroom-action-accept"
    });
    acceptBtn.onclick = () => {
      // Dispatch accept action
      acceptEdit(view, this.edit);
    };
    
    // Reject button
    const rejectBtn = container.createEl("button", {
      text: "✗",
      cls: "writersroom-action-reject"
    });
    rejectBtn.onclick = () => {
      // Dispatch reject action
      rejectEdit(view, this.edit);
    };
    
    // Edit type badge
    const badge = container.createEl("span", {
      text: this.edit.type,
      cls: `writersroom-badge-${this.edit.type}`
    });
    
    return container;
  }
}

// Add widget to end of line
builder.add(lineInfo.to, lineInfo.to, 
  Decoration.widget({
    widget: new EditActionWidget(edit, anchorId),
    side: 1 // After line content
  })
);
```

**Benefits**:
- Accept/reject inline without sidebar
- Visual edit type indicators
- Better UX for quick actions

#### 4. **Settings Facet**
```typescript
// Define facet
export const writersRoomSettingsFacet = Facet.define<WritersRoomSettings>({
  combine: (values) => values[0]
});

// Register with compartment
this.settingsCompartment = new Compartment();
this.registerEditorExtension(
  this.settingsCompartment.of(writersRoomSettingsFacet.of(this.settings))
);

// Update reactively
async saveSettings() {
  await this.saveData({ settings: this.settings, edits: ... });
  
  this.app.workspace.iterateAllLeaves(leaf => {
    if (!(leaf.view instanceof MarkdownView)) return;
    const editorView = (leaf.view.editor as any)?.cm as EditorView;
    if (!editorView) return;
    
    editorView.dispatch({
      effects: this.settingsCompartment.reconfigure(
        writersRoomSettingsFacet.of(this.settings)
      )
    });
  });
}

// Access in ViewPlugin
const settings = view.state.facet(writersRoomSettingsFacet);
```

**Benefits**:
- Reactive settings updates
- No manual refresh needed
- Clean access to settings in extensions

---

### 🤔 Medium Priority (Consider)

#### 5. **Live Preview Detection**
```typescript
import { editorLivePreviewField } from "obsidian";

function isLivePreview(state: EditorState): boolean {
  return state.field(editorLivePreviewField).valueOf();
}

// In ViewPlugin
update(update: ViewUpdate) {
  if (!isLivePreview(update.state)) {
    // Clear decorations in source mode
    this.decorations = Decoration.none;
    return;
  }
  // ... normal update
}
```

**Benefits**:
- Don't show highlights in source mode
- Better performance
- Less visual clutter

#### 6. **Document Change Mapping**
```typescript
// Fast Text Color automatically maps decorations to document changes
update(value, transaction) {
  let decorations = value.map(transaction.changes); // KEY: Maps positions
  for (const effect of transaction.effects) {
    if (effect.is(setEditorHighlightsEffect)) {
      decorations = buildEditorHighlightDecorations(effect.value);
    }
  }
  return decorations;
}
```

**We already do this!** ✅
- Our StateField already calls `value.map(transaction.changes)`
- Decorations automatically adjust to edits
- Keep this!

---

### ❌ Low Priority (Don't Need)

#### 7. **Custom Parser (Lezer)**
- Fast Text Color needs this for parsing custom syntax in document
- We don't need this - our data comes from external JSON
- Would be overkill for our use case

#### 8. **Incremental Parsing**
- Fast Text Color reparsing on every keystroke
- We don't parse document content
- External JSON updates are infrequent
- Manual refresh is fine

---

## Implementation Plan

### Phase 1: Quick Wins (1-2 hours)
1. ✅ Switch from `Decoration.line()` to `Decoration.mark()`
2. ✅ Add live preview detection
3. ✅ Add viewport optimization to ViewPlugin

### Phase 2: Enhanced UX (2-4 hours)
1. Add interactive widgets for accept/reject
2. Add edit type badges
3. Add hover previews for output text

### Phase 3: Polish (1-2 hours)
1. Add settings facet for reactive updates
2. Optimize decoration building
3. Add CSS transitions for smooth highlights

---

## Code Examples to Steal

### 1. Viewport-Optimized ViewPlugin
```typescript
// From: TextColorViewPlugin.ts
class WritersRoomViewPlugin implements PluginValue {
  decorations: DecorationSet;
  
  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);
  }
  
  update(update: ViewUpdate) {
    const selectionChanged = update.selectionSet;
    
    if (update.viewportChanged || selectionChanged || hasNewHighlights(update)) {
      this.decorations = this.buildDecorations(update.view);
    }
  }
  
  buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const sourcePath = getActiveFilePath(view);
    const payload = getPayloadForFile(sourcePath);
    
    if (!payload) return Decoration.none;
    
    // Only process visible ranges
    for (let { from, to } of view.visibleRanges) {
      payload.edits
        .filter(edit => {
          const lineStart = getLineStart(view.state.doc, edit.line);
          return lineStart >= from && lineStart <= to;
        })
        .forEach(edit => {
          // Build decoration for this edit
          const lineInfo = getLineInfo(view.state.doc, edit.line);
          builder.add(lineInfo.from, lineInfo.to, 
            Decoration.mark({
              class: getHighlightClasses(edit).join(' '),
              attributes: getHighlightAttributes(edit)
            })
          );
        });
    }
    
    return builder.finish();
  }
}

const pluginSpec: PluginSpec<WritersRoomViewPlugin> = {
  decorations: (value) => value.decorations
};

export const writersRoomViewPlugin = ViewPlugin.fromClass(
  WritersRoomViewPlugin,
  pluginSpec
);
```

### 2. Interactive Widget
```typescript
// From: ColorWidget.ts
export class EditActionsWidget extends WidgetType {
  edit: EditEntry;
  index: number;
  anchorId: string;
  
  constructor(edit: EditEntry, index: number, anchorId: string) {
    super();
    this.edit = edit;
    this.index = index;
    this.anchorId = anchorId;
  }
  
  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("span");
    container.addClass("writersroom-inline-actions");
    
    // Type badge
    const badge = container.createEl("span", {
      cls: `writersroom-badge writersroom-badge-${this.edit.type}`,
      text: this.edit.type.charAt(0).toUpperCase()
    });
    badge.setAttribute("title", `${this.edit.type} (${this.edit.category})`);
    
    // Only show buttons on hover (via CSS)
    const actions = container.createDiv({ cls: "writersroom-actions-hover" });
    
    // Accept button
    const accept = actions.createEl("button", {
      cls: "writersroom-action writersroom-action-accept",
      text: "✓"
    });
    accept.onclick = (e) => {
      e.stopPropagation();
      acceptEdit(view, this.edit, this.index);
    };
    
    // Reject button
    const reject = actions.createEl("button", {
      cls: "writersroom-action writersroom-action-reject",
      text: "✗"
    });
    reject.onclick = (e) => {
      e.stopPropagation();
      rejectEdit(view, this.edit, this.index);
    };
    
    // Info button - show in sidebar
    const info = actions.createEl("button", {
      cls: "writersroom-action writersroom-action-info",
      text: "i"
    });
    info.onclick = (e) => {
      e.stopPropagation();
      focusEdit(this.anchorId);
    };
    
    return container;
  }
}
```

### 3. Settings Facet
```typescript
// From: SettingsFacet.ts
import { Facet } from "@codemirror/state";

export interface WritersRoomSettings {
  showInlineActions: boolean;
  highlightActiveEdit: boolean;
  editTypesToShow: string[];
  colorScheme: Record<string, string>;
}

export const writersRoomSettingsFacet = Facet.define<WritersRoomSettings>({
  combine: (values) => values[0] || DEFAULT_SETTINGS
});

// Usage in plugin
private settingsCompartment = new Compartment();

async onload() {
  this.registerEditorExtension([
    writersRoomEditorExtension,
    this.settingsCompartment.of(writersRoomSettingsFacet.of(this.settings))
  ]);
}

async saveSettings() {
  await this.saveData({ settings: this.settings, edits: ... });
  
  // Update all editor views
  this.app.workspace.iterateAllLeaves(leaf => {
    if (!(leaf.view instanceof MarkdownView)) return;
    const editorView = this.getEditorViewFromMarkdownView(leaf.view);
    if (!editorView) return;
    
    editorView.dispatch({
      effects: this.settingsCompartment.reconfigure(
        writersRoomSettingsFacet.of(this.settings)
      )
    });
  });
}

// Access in extensions
const settings = state.facet(writersRoomSettingsFacet);
if (settings.showInlineActions) {
  // Add inline action widgets
}
```

---

## Summary

**What Fast Text Color Does Well:**
1. ✅ ViewPlugin with viewport optimization
2. ✅ Multiple decoration types (mark, replace, widget)
3. ✅ Interactive widgets with menus
4. ✅ Settings facet for reactive updates
5. ✅ Live preview detection
6. ✅ Incremental parsing (not needed for us)

**What WritersRoom Does Well:**
1. ✅ Manual dispatch for external data updates
2. ✅ Separation of editor and sidebar views
3. ✅ Clear data flow from JSON → decorations
4. ✅ Good attribute-based interactivity

**What We Should Steal:**
1. 🎯 **HIGH**: Decoration.mark() instead of Decoration.line()
2. 🎯 **HIGH**: ViewPlugin for viewport optimization
3. 🎯 **HIGH**: Interactive widgets for inline actions
4. 🎯 **HIGH**: Settings facet for reactive updates
5. 🤔 **MED**: Live preview detection
6. ❌ **LOW**: Custom parser (don't need)

**Final Verdict**: Fast Text Color has a more sophisticated CodeMirror integration, but many features (like incremental parsing) are overkill for our use case. We should selectively adopt their patterns where they improve UX and performance.
