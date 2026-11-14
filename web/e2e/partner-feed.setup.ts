import { test as setup } from '@playwright/test'
import { writeFeed } from './board.ts'

setup('the partner feed serves the fixture board', () => writeFeed())
