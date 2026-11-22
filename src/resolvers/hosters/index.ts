import type { UrlResolver } from '../types';
import { archiveOrgResolver } from './archiveorg';
import { buzzheavierResolver } from './buzzheavier';
import { dropboxResolver } from './dropbox';
import { gdriveResolver } from './gdrive';
import { githubResolver } from './github';
import { gofileResolver } from './gofile';
import { huggingfaceResolver } from './huggingface';
import { mediafireResolver } from './mediafire';
import { onefichierResolver } from './onefichier';
import { pixeldrainResolver } from './pixeldrain';

export const BUILTIN_HOSTER_RESOLVERS: UrlResolver[] = [
  pixeldrainResolver,
  gdriveResolver,
  gofileResolver,
  mediafireResolver,
  dropboxResolver,
  githubResolver,
  huggingfaceResolver,
  archiveOrgResolver,
  buzzheavierResolver,
  onefichierResolver,
];

export {
  archiveOrgResolver,
  buzzheavierResolver,
  dropboxResolver,
  gdriveResolver,
  githubResolver,
  gofileResolver,
  huggingfaceResolver,
  mediafireResolver,
  onefichierResolver,
  pixeldrainResolver,
};
