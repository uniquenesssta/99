// HanFontManager native Windows font helper.
// Build target: x86_64 Windows PE, no CRT, no import libs required.
// Commands:
//   hfm-font-helper.exe add [--notify] <font-path>...
//   hfm-font-helper.exe remove [--notify] <font-path>...
//   hfm-font-helper.exe notify [--strong]
//   hfm-font-helper.exe reg-add <registry-name> <font-path> [<registry-name> <font-path>...]
//   hfm-font-helper.exe reg-delete <registry-name>...

typedef unsigned char U8;
typedef unsigned short U16;
typedef unsigned int U32;
typedef unsigned long long U64;
typedef long LONG;
typedef unsigned long ULONG;
typedef unsigned short USHORT;
typedef unsigned long DWORD;
typedef unsigned long long ULONG_PTR;
typedef long long LONG_PTR;
typedef int BOOL;
typedef unsigned long SIZE_T;
typedef void* PVOID;
typedef void* HANDLE;
typedef void* HMODULE;
typedef void* HWND;
typedef void* HKEY;
typedef U16 WCHAR;
typedef char CHAR;
typedef U8 BYTE;
typedef U64 UINT_PTR;
typedef U64 WPARAM;
typedef LONG_PTR LPARAM;
typedef LONG_PTR LRESULT;
typedef ULONG_PTR DWORD_PTR;

typedef struct _LIST_ENTRY { struct _LIST_ENTRY* Flink; struct _LIST_ENTRY* Blink; } LIST_ENTRY;
typedef struct _UNICODE_STRING { USHORT Length; USHORT MaximumLength; WCHAR* Buffer; } UNICODE_STRING;
typedef struct _ANSI_STRING { USHORT Length; USHORT MaximumLength; CHAR* Buffer; } ANSI_STRING;

typedef struct _PEB_LDR_DATA_PARTIAL {
  U32 Length; U8 Initialized; U8 pad1[3]; PVOID SsHandle;
  LIST_ENTRY InLoadOrderModuleList;
  LIST_ENTRY InMemoryOrderModuleList;
  LIST_ENTRY InInitializationOrderModuleList;
} PEB_LDR_DATA_PARTIAL;

typedef struct _PEB_PARTIAL {
  U8 Reserved1[2]; U8 BeingDebugged; U8 Reserved2[1];
  PVOID Reserved3[2];
  PEB_LDR_DATA_PARTIAL* Ldr;
} PEB_PARTIAL;

typedef struct _LDR_DATA_TABLE_ENTRY_PARTIAL {
  LIST_ENTRY InLoadOrderLinks;
  LIST_ENTRY InMemoryOrderLinks;
  LIST_ENTRY InInitializationOrderLinks;
  PVOID DllBase;
  PVOID EntryPoint;
  U32 SizeOfImage;
  UNICODE_STRING FullDllName;
  UNICODE_STRING BaseDllName;
} LDR_DATA_TABLE_ENTRY_PARTIAL;

typedef struct _IMAGE_DOS_HEADER_PARTIAL { U16 e_magic; U8 pad[58]; LONG e_lfanew; } IMAGE_DOS_HEADER_PARTIAL;
typedef struct _IMAGE_DATA_DIRECTORY { U32 VirtualAddress; U32 Size; } IMAGE_DATA_DIRECTORY;
typedef struct _IMAGE_EXPORT_DIRECTORY {
  U32 Characteristics;
  U32 TimeDateStamp;
  U16 MajorVersion;
  U16 MinorVersion;
  U32 Name;
  U32 Base;
  U32 NumberOfFunctions;
  U32 NumberOfNames;
  U32 AddressOfFunctions;
  U32 AddressOfNames;
  U32 AddressOfNameOrdinals;
} IMAGE_EXPORT_DIRECTORY;

typedef LONG (__stdcall *PFN_LdrLoadDll)(WCHAR*, ULONG*, UNICODE_STRING*, PVOID*);
typedef LONG (__stdcall *PFN_LdrGetProcedureAddress)(PVOID, ANSI_STRING*, ULONG, PVOID*);
typedef WCHAR* (__stdcall *PFN_GetCommandLineW)(void);
typedef HANDLE (__stdcall *PFN_GetStdHandle)(DWORD);
typedef BOOL (__stdcall *PFN_WriteFile)(HANDLE, const void*, DWORD, DWORD*, void*);
typedef void (__stdcall *PFN_ExitProcess)(U32);
typedef int (__stdcall *PFN_AddFontResourceExW)(const WCHAR*, DWORD, void*);
typedef BOOL (__stdcall *PFN_RemoveFontResourceExW)(const WCHAR*, DWORD, void*);
typedef BOOL (__stdcall *PFN_SendNotifyMessageW)(HWND, U32, WPARAM, LPARAM);
typedef BOOL (__stdcall *PFN_PostMessageW)(HWND, U32, WPARAM, LPARAM);
typedef LRESULT (__stdcall *PFN_SendMessageTimeoutW)(HWND, U32, WPARAM, LPARAM, U32, U32, DWORD_PTR*);
typedef LONG (__stdcall *PFN_RegCreateKeyExW)(HKEY, const WCHAR*, DWORD, WCHAR*, DWORD, DWORD, void*, HKEY*, DWORD*);
typedef LONG (__stdcall *PFN_RegSetValueExW)(HKEY, const WCHAR*, DWORD, DWORD, const BYTE*, DWORD);
typedef LONG (__stdcall *PFN_RegDeleteValueW)(HKEY, const WCHAR*);
typedef LONG (__stdcall *PFN_RegCloseKey)(HKEY);

#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define HWND_BROADCAST ((HWND)(ULONG_PTR)0xffff)
#define WM_FONTCHANGE 0x001D
#define SMTO_ABORTIFHUNG 0x0002
#define REG_SZ 1
#define KEY_SET_VALUE 0x0002
#define ERROR_SUCCESS 0
#define MAX_ARGS 1400
#define MAX_CMD 32768
#define HKEY_CURRENT_USER ((HKEY)(ULONG_PTR)0xFFFFFFFF80000001ULL)

static PFN_LdrLoadDll pLdrLoadDll;
static PFN_LdrGetProcedureAddress pLdrGetProcedureAddress;
static PFN_GetCommandLineW pGetCommandLineW;
static PFN_GetStdHandle pGetStdHandle;
static PFN_WriteFile pWriteFile;
static PFN_ExitProcess pExitProcess;
static PFN_AddFontResourceExW pAddFontResourceExW;
static PFN_RemoveFontResourceExW pRemoveFontResourceExW;
static PFN_SendNotifyMessageW pSendNotifyMessageW;
static PFN_PostMessageW pPostMessageW;
static PFN_SendMessageTimeoutW pSendMessageTimeoutW;
static PFN_RegCreateKeyExW pRegCreateKeyExW;
static PFN_RegSetValueExW pRegSetValueExW;
static PFN_RegDeleteValueW pRegDeleteValueW;
static PFN_RegCloseKey pRegCloseKey;

static WCHAR g_cmd_copy[MAX_CMD];
static WCHAR* g_argv[MAX_ARGS];
static char g_out[1048576];
static U32 g_out_len = 0;

static void* get_peb(void) {
  void* p;
  __asm__("movq %%gs:0x60, %0" : "=r"(p));
  return p;
}

static int ascii_eq(const char* a, const char* b) {
  while (*a && *b) { if (*a != *b) return 0; a++; b++; }
  return *a == 0 && *b == 0;
}

static int w_ascii_eq_i(const WCHAR* w, const char* a) {
  while (*w && *a) {
    U16 c = *w++;
    if (c >= 'a' && c <= 'z') c = (U16)(c - 32);
    char ca = *a++;
    if (ca >= 'a' && ca <= 'z') ca = (char)(ca - 32);
    if ((U16)ca != c) return 0;
  }
  return *w == 0 && *a == 0;
}

static int unicode_basename_eq_i(const UNICODE_STRING* u, const char* ascii) {
  if (!u || !u->Buffer) return 0;
  U32 chars = u->Length / 2;
  U32 start = 0;
  for (U32 i = 0; i < chars; i++) {
    WCHAR c = u->Buffer[i];
    if (c == (WCHAR)'\\' || c == (WCHAR)'/') start = i + 1;
  }
  U32 j = start;
  const char* a = ascii;
  while (j < chars && *a) {
    U16 c = u->Buffer[j++];
    if (c >= 'a' && c <= 'z') c = (U16)(c - 32);
    char ca = *a++;
    if (ca >= 'a' && ca <= 'z') ca = (char)(ca - 32);
    if ((U16)ca != c) return 0;
  }
  return j == chars && *a == 0;
}

static PVOID find_module_base(const char* baseName) {
  PEB_PARTIAL* peb = (PEB_PARTIAL*)get_peb();
  if (!peb || !peb->Ldr) return 0;
  LIST_ENTRY* head = &peb->Ldr->InLoadOrderModuleList;
  for (LIST_ENTRY* it = head->Flink; it && it != head; it = it->Flink) {
    LDR_DATA_TABLE_ENTRY_PARTIAL* e = (LDR_DATA_TABLE_ENTRY_PARTIAL*)it;
    if (unicode_basename_eq_i(&e->BaseDllName, baseName)) return e->DllBase;
  }
  return 0;
}

static PVOID resolve_export_raw(PVOID module, const char* name) {
  if (!module) return 0;
  U8* base = (U8*)module;
  IMAGE_DOS_HEADER_PARTIAL* dos = (IMAGE_DOS_HEADER_PARTIAL*)base;
  if (dos->e_magic != 0x5A4D) return 0;
  U8* nt = base + dos->e_lfanew;
  if (*(U32*)nt != 0x00004550) return 0;
  U16 optMagic = *(U16*)(nt + 24);
  U32 dataDirOffset = (optMagic == 0x20B) ? 24 + 112 : 24 + 96;
  IMAGE_DATA_DIRECTORY* dirs = (IMAGE_DATA_DIRECTORY*)(nt + dataDirOffset);
  U32 exportRva = dirs[0].VirtualAddress;
  if (!exportRva) return 0;
  IMAGE_EXPORT_DIRECTORY* exp = (IMAGE_EXPORT_DIRECTORY*)(base + exportRva);
  U32* names = (U32*)(base + exp->AddressOfNames);
  U16* ords = (U16*)(base + exp->AddressOfNameOrdinals);
  U32* funcs = (U32*)(base + exp->AddressOfFunctions);
  for (U32 i = 0; i < exp->NumberOfNames; i++) {
    char* n = (char*)(base + names[i]);
    if (ascii_eq(n, name)) {
      U16 ord = ords[i];
      U32 rva = funcs[ord];
      if (!rva) return 0;
      return (PVOID)(base + rva);
    }
  }
  return 0;
}

static U32 c_strlen(const char* s) { U32 n = 0; while (s && s[n]) n++; return n; }
static U32 w_strlen(const WCHAR* s) { U32 n = 0; while (s && s[n]) n++; return n; }

static void init_ansi(ANSI_STRING* s, char* text) {
  s->Length = (USHORT)c_strlen(text);
  s->MaximumLength = (USHORT)(s->Length + 1);
  s->Buffer = text;
}

static void init_unicode(UNICODE_STRING* s, WCHAR* text) {
  s->Length = (USHORT)(w_strlen(text) * 2);
  s->MaximumLength = (USHORT)(s->Length + 2);
  s->Buffer = text;
}

static PVOID get_proc(PVOID module, char* name) {
  ANSI_STRING a;
  PVOID out = 0;
  init_ansi(&a, name);
  if (!pLdrGetProcedureAddress) return 0;
  if (pLdrGetProcedureAddress(module, &a, 0, &out) < 0) return 0;
  return out;
}

static PVOID load_dll(WCHAR* name) {
  UNICODE_STRING u;
  PVOID out = 0;
  init_unicode(&u, name);
  if (!pLdrLoadDll) return 0;
  if (pLdrLoadDll(0, 0, &u, &out) < 0) return 0;
  return out;
}

static void out_ch(char c) { if (g_out_len + 1 < sizeof(g_out)) g_out[g_out_len++] = c; }
static void out_s(const char* s) { while (*s) out_ch(*s++); }
static void out_u32(U32 v) {
  char tmp[16]; U32 n = 0;
  if (!v) { out_ch('0'); return; }
  while (v && n < 16) { tmp[n++] = (char)('0' + (v % 10)); v /= 10; }
  while (n) out_ch(tmp[--n]);
}

static void out_utf8_code(U32 cp) {
  if (cp <= 0x7F) { out_ch((char)cp); }
  else if (cp <= 0x7FF) { out_ch((char)(0xC0 | (cp >> 6))); out_ch((char)(0x80 | (cp & 0x3F))); }
  else if (cp <= 0xFFFF) { out_ch((char)(0xE0 | (cp >> 12))); out_ch((char)(0x80 | ((cp >> 6) & 0x3F))); out_ch((char)(0x80 | (cp & 0x3F))); }
  else { out_ch((char)(0xF0 | (cp >> 18))); out_ch((char)(0x80 | ((cp >> 12) & 0x3F))); out_ch((char)(0x80 | ((cp >> 6) & 0x3F))); out_ch((char)(0x80 | (cp & 0x3F))); }
}

static void out_json_wstr(const WCHAR* s) {
  out_ch('"');
  for (U32 i = 0; s && s[i]; i++) {
    U32 cp = s[i];
    if (cp == '"') { out_s("\\\""); }
    else if (cp == '\\') { out_s("\\\\"); }
    else if (cp == '\b') { out_s("\\b"); }
    else if (cp == '\f') { out_s("\\f"); }
    else if (cp == '\n') { out_s("\\n"); }
    else if (cp == '\r') { out_s("\\r"); }
    else if (cp == '\t') { out_s("\\t"); }
    else if (cp < 0x20) { out_s("\\u00"); char hex[] = "0123456789abcdef"; out_ch(hex[(cp >> 4) & 15]); out_ch(hex[cp & 15]); }
    else {
      if (cp >= 0xD800 && cp <= 0xDBFF && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
        U32 hi = cp - 0xD800; U32 lo = s[++i] - 0xDC00; cp = 0x10000 + ((hi << 10) | lo);
      }
      out_utf8_code(cp);
    }
  }
  out_ch('"');
}

static void flush_and_exit(U32 code) {
  if (pWriteFile && pGetStdHandle) {
    DWORD wrote = 0;
    HANDLE h = pGetStdHandle(STD_OUTPUT_HANDLE);
    if (h) pWriteFile(h, g_out, g_out_len, &wrote, 0);
  }
  if (pExitProcess) pExitProcess(code);
  for (;;) {}
}

static int parse_args(void) {
  WCHAR* cmd = pGetCommandLineW ? pGetCommandLineW() : 0;
  if (!cmd) return 0;
  U32 i = 0;
  while (cmd[i] && i + 1 < MAX_CMD) { g_cmd_copy[i] = cmd[i]; i++; }
  g_cmd_copy[i] = 0;
  WCHAR* p = g_cmd_copy;
  int argc = 0;
  while (*p && argc < MAX_ARGS) {
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) break;
    if (*p == '"') {
      p++;
      g_argv[argc++] = p;
      while (*p && *p != '"') p++;
      if (*p) *p++ = 0;
    } else {
      g_argv[argc++] = p;
      while (*p && *p != ' ' && *p != '\t') p++;
      if (*p) *p++ = 0;
    }
  }
  return argc;
}

static void notify_font_change(int strong) {
  if (strong && pSendMessageTimeoutW) {
    DWORD_PTR result = 0;
    pSendMessageTimeoutW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0, SMTO_ABORTIFHUNG, 900, &result);
  }
  if (pSendNotifyMessageW) pSendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
  if (pPostMessageW) pPostMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
}

static void emit_error(const char* msg) {
  out_s("{\"ok\":false,\"message\":\"");
  out_s(msg);
  out_s("\"}\n");
  flush_and_exit(2);
}

static void command_add_remove(int argc, int removeMode) {
  int notify = 0;
  int first = 2;
  if (argc > 2 && w_ascii_eq_i(g_argv[2], "--notify")) { notify = 1; first = 3; }
  out_s("{\"ok\":true,\"results\":[");
  int emitted = 0;
  int success = 0;
  for (int i = first; i < argc; i++) {
    int count = 0;
    int ok = 1;
    if (removeMode) {
      if (!pRemoveFontResourceExW) ok = 0;
      else {
        for (int j = 0; j < 8; j++) {
          BOOL removed = pRemoveFontResourceExW(g_argv[i], 0, 0);
          if (removed) count++; else break;
        }
      }
    } else {
      if (!pAddFontResourceExW) ok = 0;
      else {
        count = pAddFontResourceExW(g_argv[i], 0, 0);
        if (count < 1) ok = 0;
      }
    }
    if (emitted) out_ch(',');
    emitted = 1;
    out_s("{\"path\":"); out_json_wstr(g_argv[i]);
    out_s(",\"ok\":"); out_s(ok ? "true" : "false");
    out_s(",\"count\":"); out_u32((U32)count);
    out_s(",\"message\":\""); out_s(ok ? "ok" : (removeMode ? "RemoveFontResourceExW failed" : "AddFontResourceExW failed")); out_s("\"}");
    if (ok) success++;
  }
  if (notify && success) notify_font_change(0);
  out_s("],\"count\":"); out_u32((U32)success); out_s("}\n");
  flush_and_exit(0);
}

static WCHAR g_font_key[] = { 'S','o','f','t','w','a','r','e','\\','M','i','c','r','o','s','o','f','t','\\','W','i','n','d','o','w','s',' ','N','T','\\','C','u','r','r','e','n','t','V','e','r','s','i','o','n','\\','F','o','n','t','s',0 };

static void command_reg_add(int argc) {
  if (!pRegCreateKeyExW || !pRegSetValueExW || !pRegCloseKey) emit_error("registry api unavailable");
  HKEY key = 0; DWORD disp = 0;
  LONG rc = pRegCreateKeyExW(HKEY_CURRENT_USER, g_font_key, 0, 0, 0, KEY_SET_VALUE, 0, &key, &disp);
  if (rc != ERROR_SUCCESS || !key) emit_error("RegCreateKeyExW failed");
  int count = 0; int failed = 0;
  for (int i = 2; i + 1 < argc; i += 2) {
    WCHAR* name = g_argv[i]; WCHAR* path = g_argv[i + 1];
    DWORD bytes = (DWORD)((w_strlen(path) + 1) * 2);
    LONG r = pRegSetValueExW(key, name, 0, REG_SZ, (const BYTE*)path, bytes);
    if (r == ERROR_SUCCESS) count++; else failed++;
  }
  pRegCloseKey(key);
  out_s("{\"ok\":"); out_s(failed ? "false" : "true"); out_s(",\"count\":"); out_u32((U32)count); out_s(",\"failed\":"); out_u32((U32)failed); out_s("}\n");
  flush_and_exit(failed ? 3 : 0);
}

static void command_reg_delete(int argc) {
  if (!pRegCreateKeyExW || !pRegDeleteValueW || !pRegCloseKey) emit_error("registry api unavailable");
  HKEY key = 0; DWORD disp = 0;
  LONG rc = pRegCreateKeyExW(HKEY_CURRENT_USER, g_font_key, 0, 0, 0, KEY_SET_VALUE, 0, &key, &disp);
  if (rc != ERROR_SUCCESS || !key) emit_error("RegCreateKeyExW failed");
  int count = 0;
  for (int i = 2; i < argc; i++) {
    LONG r = pRegDeleteValueW(key, g_argv[i]);
    if (r == ERROR_SUCCESS) count++;
  }
  pRegCloseKey(key);
  out_s("{\"ok\":true,\"count\":"); out_u32((U32)count); out_s("}\n");
  flush_and_exit(0);
}

void mainCRTStartup(void) {
  PVOID ntdll = find_module_base("ntdll.dll");
  pLdrLoadDll = (PFN_LdrLoadDll)resolve_export_raw(ntdll, "LdrLoadDll");
  pLdrGetProcedureAddress = (PFN_LdrGetProcedureAddress)resolve_export_raw(ntdll, "LdrGetProcedureAddress");
  if (!pLdrLoadDll || !pLdrGetProcedureAddress) {
    out_s("{\"ok\":false,\"message\":\"ntdll loader unavailable\"}\n");
    for (;;) {}
  }

  WCHAR kernel32Name[] = { 'k','e','r','n','e','l','3','2','.','d','l','l',0 };
  WCHAR gdi32Name[] = { 'g','d','i','3','2','.','d','l','l',0 };
  WCHAR user32Name[] = { 'u','s','e','r','3','2','.','d','l','l',0 };
  WCHAR advapi32Name[] = { 'a','d','v','a','p','i','3','2','.','d','l','l',0 };

  PVOID kernel32 = load_dll(kernel32Name);
  PVOID gdi32 = load_dll(gdi32Name);
  PVOID user32 = load_dll(user32Name);
  PVOID advapi32 = load_dll(advapi32Name);

  pGetCommandLineW = (PFN_GetCommandLineW)get_proc(kernel32, "GetCommandLineW");
  pGetStdHandle = (PFN_GetStdHandle)get_proc(kernel32, "GetStdHandle");
  pWriteFile = (PFN_WriteFile)get_proc(kernel32, "WriteFile");
  pExitProcess = (PFN_ExitProcess)get_proc(kernel32, "ExitProcess");
  pAddFontResourceExW = (PFN_AddFontResourceExW)get_proc(gdi32, "AddFontResourceExW");
  pRemoveFontResourceExW = (PFN_RemoveFontResourceExW)get_proc(gdi32, "RemoveFontResourceExW");
  pSendNotifyMessageW = (PFN_SendNotifyMessageW)get_proc(user32, "SendNotifyMessageW");
  pPostMessageW = (PFN_PostMessageW)get_proc(user32, "PostMessageW");
  pSendMessageTimeoutW = (PFN_SendMessageTimeoutW)get_proc(user32, "SendMessageTimeoutW");
  pRegCreateKeyExW = (PFN_RegCreateKeyExW)get_proc(advapi32, "RegCreateKeyExW");
  pRegSetValueExW = (PFN_RegSetValueExW)get_proc(advapi32, "RegSetValueExW");
  pRegDeleteValueW = (PFN_RegDeleteValueW)get_proc(advapi32, "RegDeleteValueW");
  pRegCloseKey = (PFN_RegCloseKey)get_proc(advapi32, "RegCloseKey");

  if (!pGetCommandLineW || !pWriteFile || !pGetStdHandle || !pExitProcess) {
    // Cannot reliably report without stdout; exit if possible.
    if (pExitProcess) pExitProcess(2);
    for (;;) {}
  }

  int argc = parse_args();
  if (argc < 2) emit_error("missing command");

  if (w_ascii_eq_i(g_argv[1], "add")) command_add_remove(argc, 0);
  else if (w_ascii_eq_i(g_argv[1], "remove")) command_add_remove(argc, 1);
  else if (w_ascii_eq_i(g_argv[1], "notify")) {
    int strong = (argc > 2 && w_ascii_eq_i(g_argv[2], "--strong"));
    notify_font_change(strong);
    out_s("{\"ok\":true}\n");
    flush_and_exit(0);
  }
  else if (w_ascii_eq_i(g_argv[1], "reg-add")) command_reg_add(argc);
  else if (w_ascii_eq_i(g_argv[1], "reg-delete")) command_reg_delete(argc);
  else emit_error("unknown command");
}
