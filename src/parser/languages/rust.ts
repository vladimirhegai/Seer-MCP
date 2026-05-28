import type Parser from 'web-tree-sitter';
import type { SymbolDef } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

const RUST_BRANCH_NODES = new Set<string>([
  'if_expression', 'while_expression', 'while_let_expression', 'for_expression',
  'loop_expression', 'match_arm',
]);

const RUST_NESTING_NODES = new Set<string>([
  'if_expression', 'while_expression', 'while_let_expression', 'for_expression',
  'loop_expression', 'match_expression',
]);

export const rustExtractor: LanguageExtractor = {
  languageName: 'rust',
  extensions: ['.rs'],
  branchNodeTypes: RUST_BRANCH_NODES,
  nestingNodeTypes: RUST_NESTING_NODES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'function_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'function',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'struct_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'struct',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'enum_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'enum',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'interface', // closest semantic equivalent
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'type_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'type',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      default:
        return null;
    }
  },

  tryExtractCallName(node: Parser.SyntaxNode): string | null {
    if (node.type !== 'call_expression') return null;
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    // foo()
    if (funcNode.type === 'identifier') return funcNode.text;

    // Type::method() or path::to::func()
    // Skip ::new — it's a constructor pattern, not a meaningful symbol to track
    if (funcNode.type === 'scoped_identifier') {
      const name = funcNode.childForFieldName('name')?.text ?? null;
      return name === 'new' ? null : name;
    }

    // receiver.method()
    if (funcNode.type === 'field_expression') {
      return funcNode.childForFieldName('field')?.text ?? null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    // use std::collections::HashMap;
    if (node.type === 'use_declaration') {
      const tree = node.childForFieldName('argument');
      if (tree) return tree.text;
    }
    return null;
  },

  /**
   * Rust `impl Foo { ... }` and `impl Trait for Foo { ... }` aren't symbols
   * themselves, but methods inside them belong to `Foo`. Return `Foo` so the
   * walker can qualify nested function names accordingly.
   */
  tryExtractContextName(node: Parser.SyntaxNode): string | null {
    if (node.type !== 'impl_item') return null;
    // `impl_item` has a `type` field naming the target type. For
    // `impl Trait for Type`, the `type` field is still the target type.
    const typeNode = node.childForFieldName('type');
    if (!typeNode) return null;
    // For generic types like `Repository<User>`, just keep the bare type ident
    if (typeNode.type === 'generic_type') {
      return typeNode.childForFieldName('type')?.text ?? typeNode.text;
    }
    return typeNode.text;
  },
};
