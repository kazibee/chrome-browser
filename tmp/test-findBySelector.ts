#!/usr/bin/env bun
/**
 * Test script for findBySelector P0 implementation
 * Tests the new DOM-first query API
 */

import chromeBrowser from '../src/index.ts';

async function test() {
  console.log('Testing findBySelector P0 implementation...\n');

  const client = chromeBrowser();

  try {
    // Test 1: Launch Chrome and navigate to a test page
    console.log('1. Launching Chrome...');
    const launch = await client.launch({
      url: 'https://example.com',
      waitUntil: 'domcontentloaded',
    });
    console.log(`   ✓ Chrome launched (PID: ${launch.pid})`);

    // Test 2: Find element by selector (with wait)
    console.log('\n2. Testing findBySelector with waitFor=true...');
    const startTime = Date.now();
    const result = await client.findBySelector('h1', { waitFor: true });
    const duration = Date.now() - startTime;

    if (!result) {
      console.error('   ✗ No result returned!');
      return false;
    }

    console.log(`   ✓ Found element in ${duration}ms`);
    console.log(`   - Selector: ${result.selector}`);
    console.log(`   - Tag: ${result.tag}`);
    console.log(`   - Text: ${result.text}`);
    console.log(`   - Tier: ${result.tier} (expected: 1)`);
    console.log(`   - Duration: ${result.durationMs}ms`);

    // Test 3: Find all matching elements
    console.log('\n3. Testing findBySelector with all=true...');
    const allResults = await client.findBySelector('a', { all: true });

    if (!Array.isArray(allResults)) {
      console.error('   ✗ Expected array result!');
      return false;
    }

    console.log(`   ✓ Found ${allResults.length} elements`);
    if (allResults.length > 0) {
      console.log(`   - First link: ${allResults[0].text || allResults[0].href}`);
      console.log(`   - Tier: ${allResults[0].tier}`);
    }

    // Test 4: Non-existent selector with waitFor=false
    console.log('\n4. Testing non-existent selector with waitFor=false...');
    const missing = await client.findBySelector('.nonexistent-class-xyz', {
      waitFor: false
    });

    if (missing === undefined) {
      console.log('   ✓ Correctly returned undefined for missing element');
    } else {
      console.error('   ✗ Should return undefined for missing element');
      return false;
    }

    // Test 5: Performance check
    console.log('\n5. Performance validation...');
    const perfStart = Date.now();
    const perfResult = await client.findBySelector('body', { waitFor: false });
    const perfDuration = Date.now() - perfStart;

    if (perfDuration < 200) {
      console.log(`   ✓ Query completed in ${perfDuration}ms (<200ms target)`);
    } else {
      console.log(`   ⚠ Query took ${perfDuration}ms (target: <200ms)`);
    }

    console.log('\n✓ All tests passed!');
    return true;

  } catch (error) {
    console.error('\n✗ Test failed with error:');
    console.error(error);
    return false;
  }
}

test().then((success) => {
  process.exit(success ? 0 : 1);
});
