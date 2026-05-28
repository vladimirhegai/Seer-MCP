import type Parser from 'web-tree-sitter';
import type { SymbolDef } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

const GO_BRANCH_NODES = new Set<string>([
  'if_statement', 'for_statement', 'expression_case', 'default_case',
  'type_case', 'communication_case', 'select_statement',
]);

const GO_NESTING_NODES = new Set<string>([
  'if_statement', 'for_statement', 'expression_switch_statement',
  'type_switch_statement', 'select_statement',
]);

export const goExtractor: LanguageExtractor = {
  languageName: 'go',
  extensions: ['.go'],
  branchNodeTypes: GO_BRANCH_NODES,
  nestingNodeTypes: GO_NESTING_NODES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'function_declaration': {
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

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'method',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      // type Foo struct {} or type Foo interface {}
      case 'type_declaration': {
        // type_declaration contains one or more type_spec children
        for (const child of node.children) {
          if (child.type === 'type_spec') {
            const nameNode = child.childForFieldName('name');
            if (!nameNode) continue;
            const typeNode = child.childForFieldName('type');
            const kind = typeNode?.type === 'interface_type' ? 'interface'
                       : typeNode?.type === 'struct_type'    ? 'struct'
                       : 'type';
            return {
              name: nameNode.text,
              kind,
              lineStart: node.startPosition.row,
              lineEnd:   node.endPosition.row,
              colStart:  node.startPosition.column,
              colEnd:    node.endPosition.column,
              signature: firstLine(node),
            };
          }
        }
        return null;
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

    // pkg.Func() or receiver.Method()
    if (funcNode.type === 'selector_expression') {
      return funcNode.childForFieldName('field')?.text ?? null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    // import_spec contains a "path" field (interpreted_string_literal)
    if (node.type === 'import_spec') {
      const pathNode = node.childForFieldName('path');
      return pathNode?.text?.replace(/['"]/g, '') ?? null;
    }
    return null;
  },
};
