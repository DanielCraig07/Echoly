export interface ProjectTemplateFile {
  path: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  badgeBg: string;
  description: string;
  entryFile: string;
  files: ProjectTemplateFile[];
}

export const PROJECT_TEMPLATES: Record<string, ProjectTemplate> = {
  'java-maven': {
    id: 'java-maven',
    name: 'Java (Maven)',
    badge: 'Java',
    badgeColor: '#fb923c',
    badgeBg: 'rgba(251, 146, 60, 0.15)',
    description: '标准 Java 17/21 Maven 工程，内置 Exec 与 Compiler 插件',
    entryFile: 'src/main/java/com/demo/App.java',
    files: [
      {
        path: 'pom.xml',
        content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.demo</groupId>
    <artifactId>java-demo</artifactId>
    <version>1.0.0-SNAPSHOT</version>

    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <junit.version>5.10.0</junit.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>\${junit.version}</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.1.0</version>
                <configuration>
                    <mainClass>com.demo.App</mainClass>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`,
      },
      {
        path: 'src/main/java/com/demo/App.java',
        content: `package com.demo;

public class App {
    public static void main(String[] args) {
        System.out.println("🚀 Hello Echoly Java with Maven & JDWP Debugging!");
        int result = calculate(10, 20);
        System.out.println("Result: " + result);
    }

    public static int calculate(int a, int b) {
        return a + b;
    }
}
`,
      },
      {
        path: 'src/test/java/com/demo/AppTest.java',
        content: `package com.demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

public class AppTest {
    @Test
    public void testCalculate() {
        assertEquals(30, App.calculate(10, 20));
    }
}
`,
      },
      {
        path: '.gitignore',
        content: `target/\n.echoly/\n*.class\n.idea/\n*.iml\n`,
      },
      {
        path: 'README.md',
        content: `# Java Maven Demo Project\n\n使用 Echoly 运行与调试 Java 工程。\n\n- 运行: 点击右上角 Run 运行主类\n- 编译: \`mvn compile\`\n`,
      },
    ],
  },

  'python': {
    id: 'python',
    name: 'Python (Standard / FastAPI)',
    badge: 'Python',
    badgeColor: '#34d399',
    badgeBg: 'rgba(52, 211, 153, 0.15)',
    description: '标准 Python 现代分层工程，包含 src 源码、计算模块与 tests 单元测试',
    entryFile: 'src/main.py',
    files: [
      {
        path: 'src/main.py',
        content: `#!/usr/bin/env python3
import sys
import os

# 确保同级模块在各执行环境下可直接导入
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from calculator import add, multiply

def greet(name: str) -> str:
    message = f"🚀 Hello {name}! Welcome to Echoly Python with debugpy & Pyright!"
    return message

def main():
    name = "Developer"
    print(greet(name))
    
    # 模块函数调用与数据处理
    val1, val2 = 12, 18
    sum_res = add(val1, val2)
    mul_res = multiply(val1, val2)
    
    user_info = {
        "name": name,
        "role": "Admin",
        "addition": f"{val1} + {val2} = {sum_res}",
        "multiplication": f"{val1} * {val2} = {mul_res}",
        "skills": ["Python", "C++", "Java", "Go"],
    }
    print(f"📊 Process Result: {user_info}")

if __name__ == "__main__":
    main()
`,
      },
      {
        path: 'src/calculator.py',
        content: `"""
Echoly Python 演示业务逻辑模块
提供基础计算函数，用于演示打点调试与单步跳入 (Step Into)
"""

def add(a: int, b: int) -> int:
    result = a + b
    return result

def multiply(a: int, b: int) -> int:
    result = a * b
    return result
`,
      },
      {
        path: 'tests/test_calculator.py',
        content: `from src.calculator import add, multiply

def test_add():
    assert add(10, 20) == 30
    assert add(-5, 5) == 0

def test_multiply():
    assert multiply(3, 7) == 21
`,
      },
      {
        path: 'requirements.txt',
        content: `debugpy>=1.8.0\npytest>=8.0.0\n`,
      },
      {
        path: 'pyproject.toml',
        content: `[project]
name = "python-demo"
version = "0.1.0"
description = "Python standard layered demo project for Echoly"
requires-python = ">=3.9"

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
`,
      },
      {
        path: '.gitignore',
        content: `__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.echoly/\n.pytest_cache/\n*.egg-info/\n`,
      },
      {
        path: 'README.md',
        content: `# Python Standard Demo Project

使用 Echoly 现代工程环境运行与调试 Python。

### 目录结构
- \`src/main.py\`: 项目主入口
- \`src/calculator.py\`: 业务计算模块
- \`tests/test_calculator.py\`: Pytest 单元测试
- \`requirements.txt\`: 依赖配置（包含 debugpy 调试器）

### 运行与调试
1. **安装依赖 (可选/推荐)**:
   \`\`\`bash
   pip install -r requirements.txt
   \`\`\`
2. **运行**: 点击右上角 **Run** 即可执行当前文件；
3. **断点调试**: 在代码行号左侧单击打上红点断点，点击右上角 **Debug** 即可单步跟踪调试；
4. **运行测试**: 在终端中输入 \`pytest\`。
`,
      },
    ],
  },

  'go': {
    id: 'go',
    name: 'Go (Module)',
    badge: 'Go',
    badgeColor: '#2dd4bf',
    badgeBg: 'rgba(45, 212, 191, 0.15)',
    description: '标准 Go Module 分层工程，包含 cmd/app 主程序与 internal 内部包',
    entryFile: 'cmd/app/main.go',
    files: [
      {
        path: 'go.mod',
        content: `module demo\n\ngo 1.21\n`,
      },
      {
        path: 'cmd/app/main.go',
        content: `package main

import (
	"fmt"
	"time"

	"demo/internal/calc"
)

type ServerConfig struct {
	Port int
	Host string
	Name string
}

func main() {
	cfg := ServerConfig{
		Port: 8080,
		Host: "127.0.0.1",
		Name: "Echoly-Go-Server",
	}

	fmt.Printf("🚀 Starting %s on %s:%d\\n", cfg.Name, cfg.Host, cfg.Port)
	result := calc.Add(15, 25)
	fmt.Printf("Calculation result: %d (time: %s)\\n", result, time.Now().Format(time.RFC3339))
}
`,
      },
      {
        path: 'internal/calc/calc.go',
        content: `package calc

// Add 计算两整数之和
func Add(a, b int) int {
	return a + b
}

// Multiply 计算两整数之积
func Multiply(a, b int) int {
	return a * b
}
`,
      },
      {
        path: 'internal/calc/calc_test.go',
        content: `package calc

import "testing"

func TestAdd(t *testing.T) {
	got := Add(2, 3)
	if got != 5 {
		t.Errorf("Add(2, 3) = %d; want 5", got)
	}
}
`,
      },
      {
        path: '.gitignore',
        content: `bin/\n.echoly/\n*.exe\n*.out\n`,
      },
      {
        path: 'README.md',
        content: `# Go Module Standard Demo Project

### 目录结构
- \`cmd/app/main.go\`: 主程序入口
- \`internal/calc/calc.go\`: 内部核心计算逻辑
- \`internal/calc/calc_test.go\`: 单元测试

### 命令指令
- 运行主程序: \`go run ./cmd/app\`
- 运行所有测试: \`go test ./...\`
`,
      },
    ],
  },

  'node-ts': {
    id: 'node-ts',
    name: 'Node.js (TypeScript)',
    badge: 'Node/TS',
    badgeColor: '#38bdf8',
    badgeBg: 'rgba(56, 189, 248, 0.15)',
    description: '现代 TypeScript 服务端工程，内置 ts-node 与 ESNext 编译',
    entryFile: 'src/index.ts',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "ts-demo",
  "version": "1.0.0",
  "description": "TypeScript Node demo for Echoly",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "ts-node": "^10.9.2",
    "tsx": "^4.7.0",
    "typescript": "^5.0.0"
  }
}
`,
      },
      {
        path: 'tsconfig.json',
        content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
`,
      },
      {
        path: 'src/index.ts',
        content: `interface User {
  id: number;
  username: string;
  active: boolean;
}

function displayGreeting(user: User): void {
  console.log(\`🚀 Hello, \${user.username}! Welcome to Echoly Node.js & TypeScript!\`);
  console.log(\`User status: \${user.active ? 'Online' : 'Offline'}\`);
}

const currentUser: User = {
  id: 1001,
  username: 'Developer',
  active: true,
};

displayGreeting(currentUser);
`,
      },
      {
        path: '.gitignore',
        content: `node_modules/\ndist/\n.echoly/\n*.log\n`,
      },
      {
        path: 'README.md',
        content: `# Node.js / TypeScript Demo Project\n\n- 开发运行: \`npm run dev\`\n- 编译: \`npm run build\`\n`,
      },
    ],
  },

  'cpp-cmake': {
    id: 'cpp-cmake',
    name: 'C++ (CMake)',
    badge: 'C++',
    badgeColor: '#60a5fa',
    badgeBg: 'rgba(59, 130, 246, 0.15)',
    description: '标准 C++17/20 CMake 工程，支持 Clangd、Option+O 头源切换与 LLDB-DAP',
    entryFile: 'src/main.cpp',
    files: [
      {
        path: 'CMakeLists.txt',
        content: `cmake_minimum_required(VERSION 3.15)
project(CppDemo VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include_directories(include)

add_executable(app src/main.cpp)
`,
      },
      {
        path: 'src/main.cpp',
        content: `#include <iostream>
#include "demo.h"

int main(int argc, char** argv) {
    std::cout << "🚀 Hello Echoly C++ with Clangd & LLDB-DAP!" << std::endl;
    demoGreeting();
    return 0;
}
`,
      },
      {
        path: 'include/demo.h',
        content: `#pragma once
#include <iostream>

inline void demoGreeting() {
    std::cout << "✨ Header & Source switching working seamlessly!" << std::endl;
}
`,
      },
      {
        path: '.clangd',
        content: `CompileFlags:
  Add: [-std=c++17, -Wall, -Iinclude]
  CompilationDatabase: build
`,
      },
      {
        path: '.clang-format',
        content: `BasedOnStyle: Google
IndentWidth: 4
ColumnLimit: 100
`,
      },
      {
        path: '.gitignore',
        content: `build/\n.echoly/\n*.o\n*.out\n*.exe\n`,
      },
      {
        path: 'README.md',
        content: `# C++ CMake Demo Project\n\n- 编译与运行: 点击 Run 或使用 \`cmake --build build\`\n- 调试: LLDB-DAP 调试器，支持断点与变量悬浮\n`,
      },
    ],
  },
};

// 别名兼容映射
PROJECT_TEMPLATES['python-standard'] = PROJECT_TEMPLATES['python'];
PROJECT_TEMPLATES['go-module'] = PROJECT_TEMPLATES['go'];

export const PROJECT_TEMPLATE_LIST: ProjectTemplate[] = [
  PROJECT_TEMPLATES['java-maven'],
  PROJECT_TEMPLATES['python'],
  PROJECT_TEMPLATES['go'],
  PROJECT_TEMPLATES['node-ts'],
  PROJECT_TEMPLATES['cpp-cmake'],
];
