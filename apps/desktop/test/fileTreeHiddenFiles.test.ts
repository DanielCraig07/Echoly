import { describe, it, expect } from 'vitest';
import { isHiddenNode } from '../src/renderer/src/components/FileTree';
import type { FileTreeNode } from '@deepseek-ide/shared';

describe('FileTree isHiddenNode filtering', () => {
  it('identifies dotfiles as hidden when showHiddenFiles is false', () => {
    const dotfiles: FileTreeNode[] = [
      { name: '.terraform.lock.hcl', path: '.terraform.lock.hcl', isDirectory: false },
      { name: '.env', path: '.env', isDirectory: false },
      { name: '.gitignore', path: '.gitignore', isDirectory: false },
      { name: '.terraform / providers', path: '.terraform/providers', isDirectory: true },
      { name: 'providers', path: 'src/.terraform/providers', isDirectory: true },
      { name: '.hidden_folder', path: '.hidden_folder', isDirectory: true },
      { name: '.eslintrc.js', path: 'packages/shared/.eslintrc.js', isDirectory: false },
    ];

    for (const node of dotfiles) {
      expect(isHiddenNode(node, false)).toBe(true);
    }
  });

  it('keeps normal files and directories visible when showHiddenFiles is false', () => {
    const normalFiles: FileTreeNode[] = [
      { name: '__pycache__', path: '__pycache__', isDirectory: true },
      { name: 'install.sh', path: 'install.sh', isDirectory: false },
      { name: 'Main.tf', path: 'Main.tf', isDirectory: false },
      { name: 'run_terraform.sh', path: 'run_terraform.sh', isDirectory: false },
      { name: 'send_email.py', path: 'send_email.py', isDirectory: false },
      { name: 'terraform_loop.sh', path: 'terraform_loop.sh', isDirectory: false },
      { name: 'terraform.tfstate', path: 'terraform.tfstate', isDirectory: false },
      { name: 'terraform.tfstate.backup', path: 'terraform.tfstate.backup', isDirectory: false },
      { name: 'terraform.tfvars', path: 'terraform.tfvars', isDirectory: false },
      { name: 'tf.log', path: 'tf.log', isDirectory: false },
      { name: 'tf.pid', path: 'tf.pid', isDirectory: false },
    ];

    for (const node of normalFiles) {
      expect(isHiddenNode(node, false)).toBe(false);
    }
  });

  it('allows all hidden files when showHiddenFiles is true', () => {
    const mixedFiles: FileTreeNode[] = [
      { name: '.terraform.lock.hcl', path: '.terraform.lock.hcl', isDirectory: false },
      { name: '.terraform / providers', path: '.terraform/providers', isDirectory: true },
      { name: '.env', path: '.env', isDirectory: false },
      { name: 'Main.tf', path: 'Main.tf', isDirectory: false },
    ];

    for (const node of mixedFiles) {
      expect(isHiddenNode(node, true)).toBe(false);
    }
  });

  it('handles compact merged folders where one segment is hidden', () => {
    const compactNode: FileTreeNode = {
      name: 'foo / .secret / bar',
      path: 'foo/.secret/bar',
      isDirectory: true,
    };
    expect(isHiddenNode(compactNode, false)).toBe(true);
    expect(isHiddenNode(compactNode, true)).toBe(false);
  });
});
