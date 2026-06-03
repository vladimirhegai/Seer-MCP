import type Parser from 'web-tree-sitter';
import type { SymbolDef, SymbolKind } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

/**
 * C++ extractor — handles both .cpp/.cc/.cxx source files and .h/.hpp headers.
 *
 * Tree-sitter-cpp parses function names through recursive `declarator` chains,
 * which is the main complexity here. A definition like:
 *
 *   void Foo::bar(int x) { ... }
 *
 * parses as:
 *   function_definition
 *     ├ type: primitive_type "void"
 *     └ declarator: function_declarator
 *         ├ declarator: qualified_identifier
 *         │   ├ scope: namespace_identifier "Foo"
 *         │   └ name: identifier "bar"
 *         └ parameters: parameter_list
 *
 * The helper `extractDeclaratorName` walks down through pointer_declarator,
 * reference_declarator, etc. to find the leaf identifier.
 */
const CPP_BRANCH_NODES = new Set<string>([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'for_range_loop',
  'case_statement', 'catch_clause', 'conditional_expression',
]);

const CPP_NESTING_NODES = new Set<string>([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'for_range_loop',
  'switch_statement', 'catch_clause', 'try_statement',
]);

// Superset of every node type the C/C++ tryExtract* may accept. Some types
// (`class_specifier`, `alias_declaration`, `namespace_definition`) exist only
// in the C++ grammar; the parser's query compiler probes each type and drops
// any that the grammar rejects, so this list is safe to share between the
// `cpp` and `c` extractor instances.
const CPP_CANDIDATE_NODE_TYPES = [
  // tryExtractDefinition (body-gated for struct/union/enum/class)
  'function_definition',
  'class_specifier',
  'struct_specifier',
  'union_specifier',
  'enum_specifier',
  'field_declaration',
  'declaration',           // free-function prototypes / forward decls
  'type_definition',
  'alias_declaration',
  // tryExtractCallName
  'call_expression',
  // tryExtractImport
  'preproc_include',
  // tryExtractContextName — namespace foo { ... } (C++ only)
  'namespace_definition',
] as const;

export const cppExtractor: LanguageExtractor = {
  languageName: 'cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.h++', '.h'],
  branchNodeTypes: CPP_BRANCH_NODES,
  nestingNodeTypes: CPP_NESTING_NODES,
  candidateNodeTypes: CPP_CANDIDATE_NODE_TYPES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      // void foo() { ... }   or   void Foo::bar() { ... }
      case 'function_definition': {
        const declarator = node.childForFieldName('declarator');
        if (!declarator) return null;
        // Out-of-line method definitions name their owner via a
        // qualified_identifier declarator (`Vec<T>::dot`, `A::B::method`).
        // Surface the owner scope so the qualified name is `…Vec.dot`, not a
        // bare `dot` that reads like a free function.
        const qual = extractQualifiedScope(declarator);
        if (qual && qual.scopes.length > 0) {
          const def = mkDef(qual.name, 'function', node);
          def.scopePath = qual.scopes;
          return def;
        }
        const name = extractDeclaratorName(declarator);
        if (!name) return null;
        return mkDef(name, 'function', node);
      }

      // class Foo { ... };
      // The body gate is critical: without it, every forward declaration
      // (`class Foo;`) and every use of Foo as a type (`Foo *p`) also matches
      // class_specifier and would be emitted as a duplicate "class Foo" symbol.
      // We only emit when there's a real definition body.
      case 'class_specifier': {
        if (!node.childForFieldName('body')) return null;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'class', node);
      }

      // struct Foo { ... };
      // Body gate (see class_specifier above). In C, `struct_specifier`
      // appears in EVERY type reference: `int foo(struct device *dev)` parses
      // as a struct_specifier child of the parameter declaration. Without the
      // body check, we'd emit ~50k bogus "struct device" symbols on the Linux
      // kernel for one real definition.
      case 'struct_specifier': {
        if (!node.childForFieldName('body')) return null;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'struct', node);
      }

      // union Foo { ... };
      // Same body-gate rationale as struct/class. Untracked previously; tracking
      // explicitly so unions stop slipping through as anonymous type references.
      case 'union_specifier': {
        if (!node.childForFieldName('body')) return null;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'struct', node);
      }

      // enum Color { RED, GREEN };  or  enum class Color { ... };
      // Body gate (see struct_specifier). Linux has ~99k enum rows today, most
      // of which are type references like `enum dma_data_direction dir`.
      case 'enum_specifier': {
        if (!node.childForFieldName('body')) return null;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'enum', node);
      }

      // Methods declared (not defined) inside a class body. These are field
      // declarations whose declarator is a function_declarator — e.g.
      //   class Foo { void bar(); };  ← bar is a method declaration
      // We extract it as a method symbol so it can be linked from elsewhere,
      // but tag it as `symbolRole='declaration'` so default agent-facing
      // queries (top by rank, search) skip the declaration site in favour of
      // the body-bearing `void Foo::bar() { ... }` definition that lives in
      // the .cpp. Callers/callees still work because edges resolve by name.
      case 'field_declaration': {
        const declarator = node.childForFieldName('declarator');
        if (!declarator || declarator.type !== 'function_declarator') return null;
        const name = extractDeclaratorName(declarator);
        if (!name) return null;
        const def = mkDef(name, 'method', node);
        def.symbolRole = 'declaration';
        return def;
      }

      // Free-function prototypes / forward declarations at file scope, e.g.
      //   void foo(int x);
      //   extern int g_counter;          ← variable; we don't emit these
      //   struct foo;                    ← struct forward-decl (handled below)
      // tree-sitter-c/cpp parse these as `declaration` nodes whose declarator
      // is a function_declarator. They're explicit declarations, not
      // definitions; surface them with symbolRole='declaration' so callers
      // who want to navigate to "where is this announced" can find them while
      // default queries focus on the body-bearing definitions.
      case 'declaration': {
        const declarator = node.childForFieldName('declarator');
        if (!declarator || declarator.type !== 'function_declarator') return null;
        const name = extractDeclaratorName(declarator);
        if (!name) return null;
        const def = mkDef(name, 'function', node);
        def.symbolRole = 'declaration';
        return def;
      }

      // typedef int Foo;  or  using Foo = int;
      case 'type_definition': {
        const declarator = node.childForFieldName('declarator');
        const name = declarator ? extractDeclaratorName(declarator) : null;
        if (!name) return null;
        return mkDef(name, 'type', node);
      }

      case 'alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'type', node);
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

    // obj.method()  or  obj->method()
    //
    // We emit only the method's SHORT name (`add_child`), never a qualified
    // `Node.add_child`: tree-sitter has no type system, so the receiver's
    // static type (`obj`'s class) is unknowable from syntax alone. The edge's
    // `to_name` therefore can't be attributed to a specific overload, and the
    // scope-aware resolver may bind it to any same-named method. Two
    // deterministic compensations live downstream:
    //   1. behavior.ts surfaces these as clearly-labeled `heuristic-name-call`
    //      test evidence (name-based, lower confidence) so a `node->add_child()`
    //      in a test isn't invisible to `seer_behavior`.
    //   2. A SCIP precision overlay (provenance="scip") resolves the real
    //      receiver type and promotes the edge to a precise, type-resolved link.
    if (funcNode.type === 'field_expression') {
      return funcNode.childForFieldName('field')?.text ?? null;
    }

    // ns::func()  or  Class::staticMethod()
    if (funcNode.type === 'qualified_identifier') {
      // Walk down the right side — there may be nested qualified_identifiers
      let cur: Parser.SyntaxNode | null = funcNode;
      while (cur && cur.type === 'qualified_identifier') {
        const name = cur.childForFieldName('name');
        if (name && name.type === 'identifier') return name.text;
        cur = name;
      }
      return null;
    }

    // template specialization: foo<int>()
    if (funcNode.type === 'template_function') {
      const name = funcNode.childForFieldName('name');
      return name?.text ?? null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    // #include "foo.h"  or  #include <foo.h>
    if (node.type === 'preproc_include') {
      const pathNode = node.childForFieldName('path');
      if (!pathNode) return null;
      // The text includes the surrounding "" or <>
      return pathNode.text.replace(/^[<"]/, '').replace(/[>"]$/, '');
    }
    return null;
  },

  /**
   * Class/struct bodies provide naming context for nested method declarations,
   * so that `class Foo { void bar(); }` gives `bar` the qualified name `Foo.bar`.
   */
  tryExtractContextName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      // We've already emitted the class as a symbol, but we also want to
      // *re-push* its name so methods inside get `Foo.method` qualification.
      // However, the walker already pushes the def's `name` when it accepts a
      // definition — so this hook is redundant for definitions that are also
      // emitted. We return null here and let walker's normal def-stack push
      // handle nesting. (This hook is reserved for nodes like Rust impl that
      // AREN'T emitted as symbols themselves.)
      return null;
    }
    // namespace foo { ... }  — push the namespace name for qualified context
    if (node.type === 'namespace_definition') {
      const nameNode = node.childForFieldName('name');
      return nameNode?.text ?? null;
    }
    return null;
  },
};

/**
 * Walk a declarator chain (which may be wrapped in pointer/reference/array
 * declarators) to find the inner identifier. Examples:
 *
 *   identifier             "foo"           → "foo"
 *   pointer_declarator     "*foo"          → "foo"
 *   function_declarator    "foo(int)"      → "foo"  (recurse on inner declarator)
 *   qualified_identifier   "Foo::bar"      → "bar"  (the leaf name)
 *   field_identifier       "method"        → "method"
 *   destructor_name        "~Foo"          → "~Foo"
 *   operator_name          "operator=="    → "operator=="
 */
function extractDeclaratorName(node: Parser.SyntaxNode): string | null {
  // Direct identifier nodes
  if (node.type === 'identifier' || node.type === 'field_identifier') {
    return node.text;
  }
  if (node.type === 'destructor_name' || node.type === 'operator_name') {
    return node.text;
  }

  // Qualified: Foo::bar → "bar"
  if (node.type === 'qualified_identifier') {
    const name = node.childForFieldName('name');
    return name ? extractDeclaratorName(name) : null;
  }

  // Wrapping declarators — recurse into the `declarator` field
  if (
    node.type === 'function_declarator' ||
    node.type === 'pointer_declarator' ||
    node.type === 'reference_declarator' ||
    node.type === 'array_declarator' ||
    node.type === 'parenthesized_declarator'
  ) {
    const inner = node.childForFieldName('declarator');
    return inner ? extractDeclaratorName(inner) : null;
  }

  // Template names: foo<int> → "foo"
  if (node.type === 'template_function') {
    const name = node.childForFieldName('name');
    return name ? extractDeclaratorName(name) : null;
  }

  return null;
}

/**
 * For an out-of-line definition whose declarator is (or wraps) a
 * `qualified_identifier`, return the owner scope chain and the leaf name:
 *
 *   void Foo::bar() {}            → { scopes: ['Foo'],    name: 'bar' }
 *   T    Vec<T>::dot() {}         → { scopes: ['Vec'],    name: 'dot' }   (template args folded off)
 *   int  A::B::compute() {}       → { scopes: ['A','B'],  name: 'compute' }
 *   void Widget::~Widget() {}     → { scopes: ['Widget'], name: '~Widget' }
 *
 * Returns null when the declarator is unqualified (a normal free function or
 * in-class definition) so the caller falls back to the plain name path.
 */
function extractQualifiedScope(
  declarator: Parser.SyntaxNode,
): { scopes: string[]; name: string } | null {
  // Unwrap pointer/reference/function/parenthesized declarators to the core.
  let node: Parser.SyntaxNode | null = declarator;
  while (
    node &&
    (node.type === 'function_declarator' ||
      node.type === 'pointer_declarator' ||
      node.type === 'reference_declarator' ||
      node.type === 'parenthesized_declarator')
  ) {
    node = node.childForFieldName('declarator');
  }
  if (!node || node.type !== 'qualified_identifier') return null;

  const scopes: string[] = [];
  let cur: Parser.SyntaxNode | null = node;
  while (cur && cur.type === 'qualified_identifier') {
    const scope = cur.childForFieldName('scope');
    if (scope) {
      // Fold template arguments off the scope: `Vec<T>` → `Vec`. Anonymous or
      // empty scopes are skipped rather than emitted as ''.
      const folded = scope.text.split('<')[0].trim();
      if (folded) scopes.push(folded);
    }
    cur = cur.childForFieldName('name');
  }
  const name = cur ? extractDeclaratorName(cur) : null;
  if (!name) return null;
  return { scopes, name };
}

function mkDef(name: string, kind: SymbolKind, node: Parser.SyntaxNode): SymbolDef {
  return {
    name,
    kind,
    lineStart: node.startPosition.row,
    lineEnd:   node.endPosition.row,
    colStart:  node.startPosition.column,
    colEnd:    node.endPosition.column,
    signature: firstLine(node),
  };
}
