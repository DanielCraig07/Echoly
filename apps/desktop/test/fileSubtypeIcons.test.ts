import { describe, it, expect } from 'vitest';
import { detectCodeSubtype } from '../src/renderer/src/components/FileIcons';

describe('detectCodeSubtype - Precise Project File Subtype Recognition', () => {
  describe('Java sub-types detection', () => {
    it('detects Java interfaces via code snippet or naming', () => {
      expect(detectCodeSubtype('UserService.java', 'public interface UserService { void run(); }')).toBe('interface');
      expect(detectCodeSubtype('CustomListener.java')).toBe('interface');
      expect(detectCodeSubtype('OrderMapper.java')).toBe('interface');
      expect(detectCodeSubtype('UserRepository.java')).toBe('interface');
    });

    it('detects Java enums via code snippet or naming', () => {
      expect(detectCodeSubtype('HttpStatus.java', 'public enum HttpStatus { OK, NOT_FOUND; }')).toBe('enum');
      expect(detectCodeSubtype('OrderType.java')).toBe('enum');
      expect(detectCodeSubtype('ColorEnum.java')).toBe('enum');
    });

    it('detects Java annotations via code snippet or naming', () => {
      expect(detectCodeSubtype('Transactional.java', 'public @interface Transactional {}')).toBe('annotation');
      expect(detectCodeSubtype('LogAnnotation.java')).toBe('annotation');
    });

    it('detects Java records via code snippet or naming', () => {
      expect(detectCodeSubtype('UserDTO.java', 'public record UserDTO(String name, int age) {}')).toBe('record');
      expect(detectCodeSubtype('PointRecord.java')).toBe('record');
    });

    it('detects Java abstract classes and exceptions', () => {
      expect(detectCodeSubtype('AbstractService.java', 'public abstract class AbstractService {}')).toBe('abstract');
      expect(detectCodeSubtype('BusinessException.java', 'public class BusinessException extends RuntimeException {}')).toBe('exception');
    });

    it('detects Java test classes via naming or @Test annotation', () => {
      expect(detectCodeSubtype('UserServiceTest.java')).toBe('test');
      expect(detectCodeSubtype('OrderIT.java')).toBe('test');
      expect(detectCodeSubtype('PaymentTestCase.java')).toBe('test');
      expect(detectCodeSubtype('CustomJob.java', 'public class CustomJob { @Test public void testJob() {} }')).toBe('test');
    });

    it('defaults to standard class', () => {
      expect(detectCodeSubtype('UserServiceImpl.java', 'public class UserServiceImpl implements UserService {}')).toBe('class');
      expect(detectCodeSubtype('OrderController.java')).toBe('class');
    });
  });

  describe('Kotlin and Scala project types detection', () => {
    it('detects Kotlin files and scripts', () => {
      expect(detectCodeSubtype('App.kt')).toBe('class');
      expect(detectCodeSubtype('build.gradle.kts')).toBe('config');
      expect(detectCodeSubtype('AppTest.kt')).toBe('test');
      expect(detectCodeSubtype('UserRepository.kt', 'interface UserRepository {}')).toBe('interface');
    });

    it('detects Scala files', () => {
      expect(detectCodeSubtype('Main.scala')).toBe('class');
      expect(detectCodeSubtype('UserService.scala', 'trait UserService {}')).toBe('interface');
      expect(detectCodeSubtype('OrderSpec.scala')).toBe('test');
    });
  });

  describe('Other project types detection', () => {
    it('detects TypeScript and JavaScript tests and interfaces', () => {
      expect(detectCodeSubtype('App.test.tsx')).toBe('test');
      expect(detectCodeSubtype('utils.spec.ts')).toBe('test');
      expect(detectCodeSubtype('types.d.ts')).toBe('interface');
      expect(detectCodeSubtype('userTypes.ts')).toBe('interface');
    });

    it('detects Python entries and tests', () => {
      expect(detectCodeSubtype('test_auth.py')).toBe('test');
      expect(detectCodeSubtype('main.py')).toBe('entry');
      expect(detectCodeSubtype('__init__.py')).toBe('config');
    });

    it('detects Go tests and entries', () => {
      expect(detectCodeSubtype('server_test.go')).toBe('test');
      expect(detectCodeSubtype('main.go')).toBe('entry');
      expect(detectCodeSubtype('interface.go')).toBe('interface');
    });

    it('detects C/C++ headers, sources, entries and tests', () => {
      expect(detectCodeSubtype('vector.hpp')).toBe('interface');
      expect(detectCodeSubtype('main.cpp')).toBe('entry');
      expect(detectCodeSubtype('test_math.cpp')).toBe('test');
      expect(detectCodeSubtype('service.cpp')).toBe('class');
    });

    it('detects Rust entries, configs and tests', () => {
      expect(detectCodeSubtype('main.rs')).toBe('entry');
      expect(detectCodeSubtype('mod.rs')).toBe('config');
      expect(detectCodeSubtype('lib.rs')).toBe('class');
      expect(detectCodeSubtype('algo_test.rs')).toBe('test');
    });
  });
});
