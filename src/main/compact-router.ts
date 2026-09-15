import direct from './compact-router-direct.txt?raw';
import starter from './compact-router-starter.txt?raw';
import reselection from './compact-router-reselection.txt?raw';

export const compactRouterVersion = 'stomylos_compact_router_v1';
export const compactRouterPrompts = { direct, starter, reselection };

import eightOpener from './compact-router-eight-opener.txt?raw';
import eightDirect from './compact-router-eight-direct.txt?raw';
import eightStarter from './compact-router-eight-starter.txt?raw';
import eightReselection from './compact-router-eight-reselection.txt?raw';
export const eightRouterVersion = 'stomylos_compact_router_v2';
export const eightRouterPrompts = { direct: eightDirect, starter: eightStarter, opener: eightOpener, reselection: eightReselection };

import retainedOpener from './compact-router-retained-opener.txt?raw';
import retainedDirect from './compact-router-retained-direct.txt?raw';
import retainedStarter from './compact-router-retained-starter.txt?raw';
import retainedReselection from './compact-router-retained-reselection.txt?raw';
export const retainedRouterVersion = 'stomylos_compact_router_v3';
export const retainedRouterPrompts = { direct: retainedDirect, starter: retainedStarter, opener: retainedOpener, reselection: retainedReselection };

import currentOpener from './compact-router-six-partners-opener.txt?raw';
import currentDirect from './compact-router-six-partners-direct.txt?raw';
import currentStarter from './compact-router-six-partners-starter.txt?raw';
import currentReselection from './compact-router-six-partners-reselection.txt?raw';
export const currentRouterVersion = 'stomylos_compact_router_v4';
export const currentRouterPrompts = { direct: currentDirect, starter: currentStarter, opener: currentOpener, reselection: currentReselection };
