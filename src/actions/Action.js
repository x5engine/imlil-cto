import glob from 'fast-glob';
import { promises as fs } from 'fs';
import esprima from 'esprima';
import recast from 'recast';
import simpleGit from 'simple-git';
import path from 'path';
import jscodeshift from 'jscodeshift';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

export default class Action {
  constructor() {
    this.git = simpleGit();
    this.parser = new Parser();
    this.parser.setLanguage(JavaScript);
  }

  static async findFiles(pattern) {
    return glob(pattern);
  }

  static async readFile(filePath) {
    return fs.readFile(filePath, 'utf-8');
  }

  static async writeFile(filePath, content) {
    if (!filePath) {
      console.error('Error: filePath is undefined');
      return;
    }
    console.log(`  => Writing file: ${filePath}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const contentToWrite = typeof content === 'string' ? content : JSON.stringify(content, null, 4);
    await fs.writeFile(filePath, contentToWrite);
  }

  static async writeTest(filePath, content) {
    if (!filePath) {
      console.error('Error: test filePath is undefined');
      return;
    }
    console.log(`  => Writing test: ${filePath}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const contentToWrite = typeof content === 'string' ? content : JSON.stringify(content, null, 4);
    await fs.writeFile(filePath, contentToWrite);
  }

  /**
     * Query a file using Tree-sitter for fast structural analysis.
     */
  async queryFile(filePath, queryStr) {
    const source = await fs.readFile(filePath, 'utf-8');
    const tree = this.parser.parse(source);
    const query = new Parser.Query(JavaScript, queryStr);
    const matches = query.matches(tree.rootNode);
    return matches;
  }

  /**
     * Surgical modification using jscodeshift and recast.
     */
  static async modifyFile(filePath, transformCode) {
    if (!filePath) {
      console.error('Error: filePath is undefined for modification');
      return;
    }
    console.log(`  => Modifying file: ${filePath}`);

    let source;
    try {
      source = await fs.readFile(filePath, 'utf-8');
    } catch (e) {
      console.error(`Error reading file ${filePath}:`, e);
      return;
    }

    const j = jscodeshift.withParser('tsx');
    const api = { j, jscodeshift: j, stats: () => {} };
    const fileInfo = { path: filePath, source };

    try {
      const result = j.runTransform({ path: filePath, source: fileInfo.source }, transformCode, api, {});

      if (result && typeof result === 'string' && result !== source) {
        await fs.writeFile(filePath, result);
        console.log(`  => File modified successfully: ${filePath}`);
      } else {
        console.log(`  => No changes applied to: ${filePath}`);
      }
    } catch (error) {
      console.error(`Error executing jscodeshift transform on ${filePath}:`, error);
    }
  }

  /**
     * Specialized action for adding imports or surgical edits using AST.
     */
  static async smartEdit(filePath, editInstructions) {
    // This combines tree-sitter for finding and jscodeshift for editing.
    // For now, it will be an alias to modifyFile but with a more specialized prompt context.
    return Action.modifyFile(filePath, editInstructions);
  }

  static parseCode(code) {
    return esprima.parseScript(code, { tolerant: true, range: true, loc: true });
  }

  static modifyCode(code, transformations) {
    const ast = recast.parse(code);
    recast.visit(ast, transformations);
    return recast.print(ast).code;
  }

  async gitStatus() {
    return this.git.status();
  }

  async gitAdd(files) {
    return this.git.add(files);
  }

  async gitCommit(message) {
    return this.git.commit(message);
  }
}
