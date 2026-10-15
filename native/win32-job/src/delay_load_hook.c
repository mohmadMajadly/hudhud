/*
 * Delay-load hook of the hudhud Windows job addon (plan section 6.1).
 *
 * The addon imports the Node-API functions from "node.exe" (the import
 * library is built from node_api.def, whose module name is NODE.EXE), and
 * that import is delay-loaded (/DELAYLOAD:node.exe). The hook resolves it
 * to the module of the running process, so the addon works in any host
 * that exports Node-API from its executable (node.exe under another name,
 * Electron) and never loads a DLL named node.exe from the search path.
 *
 * Only that one name is mapped. Every other delay-load notification falls
 * through to the default helper; node.exe is the only delay-loaded module,
 * and GetModuleHandleW(NULL) cannot fail for the running executable, so the
 * default helper's LoadLibrary path is never taken.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_host_hook(unsigned int event, PDelayLoadInfo info) {
  if (event != dliNotePreLoadLibrary || info == NULL || info->szDll == NULL) {
    return NULL;
  }
  if (_stricmp(info->szDll, "node.exe") != 0) {
    return NULL;
  }
  return (FARPROC)GetModuleHandleW(NULL);
}

const PfnDliHook __pfnDliNotifyHook2 = load_host_hook;
