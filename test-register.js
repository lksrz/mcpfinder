#!/usr/bin/env node

import { runRegister } from './mcpfinder-server/src/register.js';

// Mock readline with predefined answers
const mockAnswers = [
    'https://whenmeet.me/api/mcp',  // URL
    'n',  // No auth token
    'n',  // No manual capabilities
    '',   // Default description
    'calendar,scheduling,auth-required',  // Tags
    'y',  // Requires API key (should be auto-set to y)
    'y'   // Confirm submission
];

let answerIndex = 0;
const originalQuestion = console.log;

// Override askQuestion to simulate user input
process.stdin.isTTY = true;
const originalCreateInterface = (await import('readline')).createInterface;
(await import('readline')).createInterface = function(options) {
    const rl = originalCreateInterface.call(this, options);
    const originalQuestion = rl.question.bind(rl);
    
    rl.question = function(query, callback) {
        console.log(query);
        
        // Simulate user typing
        setTimeout(() => {
            const answer = mockAnswers[answerIndex++] || '';
            console.log(`> ${answer}`);
            callback(answer);
        }, 100);
    };
    
    return rl;
};

// Run the registration
runRegister().then(() => {
    console.log('\nTest completed successfully!');
    process.exit(0);
}).catch(err => {
    console.error('\nTest failed:', err);
    process.exit(1);
});