# Edit Grouping Improvements

## Problem
When the AI model returns multiple edits for the same line (typically a replacement AND an annotation about that replacement), it was confusing for users to parse. Each edit appeared as a separate item in the sidebar.

## Solution
Implemented intelligent grouping of edits by line number to create a cleaner, more intuitive UI.

## Changes Made

### 1. Parser Logic (`editParser.ts`)
Updated `combineEditsOnSameLine()` function to:
- **Group all edits by line number** into a single map
- **Merge annotations** into substantive edits (replacement, addition, subtraction, star)
- **Handle edge cases**:
  - If multiple annotations exist on one line, combine their text with spaces
  - If multiple substantive edits exist on the same line (model error), keep only the first one
  - If only annotations exist on a line (no substantive edit), keep the first annotation

### 2. Sidebar UI (`main.ts`)
Enhanced the sidebar rendering to make merged annotations more prominent:

**Before:**
```
Original text: "..."
Suggested text: "..."
💭 Annotation text
```

**After:**
```
Original text: "..."

┌─────────────────────────────┐
│ 💭 WRITER'S NOTE:           │
│ Annotation text here...     │
└─────────────────────────────┘

Suggested text: "..."
```

### 3. CSS Styling (`main.ts`)
Added new styles for annotation boxes:
- `.writersroom-sidebar-item-annotation-box` - Container with gradient background
- `.writersroom-sidebar-item-annotation-label` - "Writer's note" label
- `.writersroom-sidebar-item-annotation-text` - The actual annotation content

**Visual Design:**
- Subtle blue gradient background
- Left border accent for visual hierarchy
- Clear separation between annotation and suggested text
- Positioned BEFORE the output text for better flow

### 4. Tests (`editParser.test.ts`)
Added comprehensive test coverage for grouping scenarios:
- ✅ Groups replacement + annotation on same line
- ✅ Combines multiple annotations into one replacement
- ✅ Keeps standalone annotations when no substantive edit exists
- ✅ Discards duplicate substantive edits (keeps first)

## User Benefits

1. **Reduced Visual Noise**: One item per line instead of multiple
2. **Better Context**: Annotations are shown prominently before the suggested revision
3. **Clearer Intent**: Users immediately understand the writer's reasoning
4. **Professional Polish**: Matches editorial workflows where comments accompany revisions

## Example Scenario

**AI Returns:**
```json
{
  "edits": [
    {
      "line": 5,
      "type": "replacement",
      "original_text": "The cat sat on the mat.",
      "output": "The cat sprawled lazily across the worn mat."
    },
    {
      "line": 5,
      "type": "annotation",
      "original_text": "The cat sat on the mat.",
      "output": "Added sensory detail to enhance imagery."
    }
  ]
}
```

**User Sees:**
- Single sidebar item for line 5
- Clear "Writer's note" explaining the rationale
- The suggested revision immediately below

## Technical Notes

- Grouping happens during parse time, not render time (more efficient)
- Preserves backward compatibility with existing edit structures
- All 22 tests passing ✅

## Annotation Formatting

### Numbered Lists Support
Annotations often contain checklists or numbered suggestions from the AI. The plugin now intelligently detects and formats numbered lists within annotations:

**Pattern Detection:**
- Detects patterns like `1)`, `2)`, `3)` followed by text
- Automatically splits into separate visual items
- Each item gets proper spacing and indentation

**Visual Formatting:**
```
Before (all on one line):
[CHECKLIST: 1) Item one 2) Item two 3) Item three]

After (formatted):
1) Item one
2) Item two  
3) Item three
```

**Implementation:**
- `formatAnnotationText()` method parses annotation content
- Regex pattern: `/\d+\)\s/` detects numbered items
- Creates separate DOM elements for each list item
- Applies special styling to numbers (bold/colored)
- Falls back to plain text for non-list content

**CSS Classes:**
- `.writersroom-annotation-list-item` - Flex container for each item
- `.writersroom-annotation-number` - The number (e.g., "1)")
- `.writersroom-annotation-content` - The item text
- `.writersroom-annotation-text-block` - Non-list text blocks

This makes AI-generated checklists and multi-point suggestions much more readable!
