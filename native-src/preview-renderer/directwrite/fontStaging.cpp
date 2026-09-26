#include "fontStaging.h"
#include "localFontFile.h"
#include <windows.h>
#include <bcrypt.h>
#include <iostream>
#include <vector>
#include <stdexcept>

namespace hfm_dw {
namespace {
struct File { HANDLE value; ~File() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
void require(bool value, const char* reason) { if (!value) throw std::runtime_error(reason); }
std::wstring normalized(std::wstring value) {
  if (value.rfind(L"\\\\?\\UNC\\",0)==0) value=L"\\\\"+value.substr(8);
  else if (value.rfind(L"\\\\?\\",0)==0) value=value.substr(4);
  require(value.size()>3 && value.find(L'\0')==std::wstring::npos, "STAGE_PATH_INVALID");
  require((value[1]==L':' && value[2]==L'\\' && value.find(L':',2)==std::wstring::npos)
    || (value.rfind(L"\\\\",0)==0 && value.find(L':')==std::wstring::npos && value[2]!=L'.' && value[2]!=L'?'), "STAGE_PATH_INVALID");
  for (auto& c:value) { if(c==L'/') c=L'\\'; }
  return value;
}
std::wstring finalPath(HANDLE handle) {
  DWORD size=GetFinalPathNameByHandleW(handle,nullptr,0,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  require(size>0 && size<32768,"STAGE_IDENTITY_UNAVAILABLE");
  std::wstring result(size,L'\0');
  DWORD written=GetFinalPathNameByHandleW(handle,result.data(),size,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  require(written>0 && written<size,"STAGE_IDENTITY_UNAVAILABLE"); result.resize(written);
  return normalized(result);
}
bool samePath(const std::wstring& a,const std::wstring& b) {
  return CompareStringOrdinal(a.c_str(),-1,b.c_str(),-1,TRUE)==CSTR_EQUAL;
}
bool sameInfo(const BY_HANDLE_FILE_INFORMATION& a,const BY_HANDLE_FILE_INFORMATION& b) {
  return a.dwVolumeSerialNumber==b.dwVolumeSerialNumber && a.nFileIndexHigh==b.nFileIndexHigh && a.nFileIndexLow==b.nFileIndexLow
    && a.nFileSizeHigh==b.nFileSizeHigh && a.nFileSizeLow==b.nFileSizeLow && CompareFileTime(&a.ftLastWriteTime,&b.ftLastWriteTime)==0;
}
}
int prepareFontStore(const std::wstring& parent) {
  auto local=localPath(parent,false);
  require((GetFileAttributesW(local.c_str()) & FILE_ATTRIBUTE_DIRECTORY)!=0,"STAGE_STORE_INVALID");
  auto directory=local+L"\\dw-fonts";
  if (!CreateDirectoryW(directory.c_str(),nullptr)) require(GetLastError()==ERROR_ALREADY_EXISTS,"STAGE_STORE_FAILED");
  localPath(directory,false);
  require((GetFileAttributesW(directory.c_str()) & FILE_ATTRIBUTE_DIRECTORY)!=0,"STAGE_STORE_INVALID");
  std::cout << "{\"type\":\"font-store\",\"version\":1,\"ok\":true}\n";
  return 0;
}
int stageFont(const std::wstring& source, const std::wstring& authorized, const std::wstring& target, const std::wstring& knownDigest) {
  auto expected=normalized(authorized); normalized(source);
  require(knownDigest==L"-" || (knownDigest.size()==64 && knownDigest.find_first_not_of(L"0123456789abcdef")==std::wstring::npos),"STAGE_INPUT_INVALID");
  auto output=localPath(target,true);
  // Resolve the destination through a held directory handle. Windows temporary
  // paths may contain 8.3 names; comparing that spelling with a normalized
  // handle path would incorrectly reject an otherwise valid local target.
  auto separator=output.find_last_of(L'\\');
  File outputDirectory{CreateFileW(output.substr(0,separator).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,
    nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr)};
  require(outputDirectory.value!=INVALID_HANDLE_VALUE,"STAGE_OUTPUT_FAILED");
  auto expectedOutput=finalPath(outputDirectory.value)+output.substr(separator);
  // FILE_SHARE_READ deliberately excludes writers and rename/delete. No NAS
  // handle escapes this killable one-shot process, including on read hangs.
  File input{CreateFileW(source.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_SEQUENTIAL_SCAN,nullptr)};
  require(input.value!=INVALID_HANDLE_VALUE,"STAGE_SOURCE_UNAVAILABLE");
  require(samePath(finalPath(input.value),expected),"STAGE_SOURCE_CHANGED");
  BY_HANDLE_FILE_INFORMATION before{},after{};
  require(GetFileInformationByHandle(input.value,&before)!=0 && GetFileType(input.value)==FILE_TYPE_DISK
    && !(before.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY),"STAGE_SOURCE_INVALID");
  require(before.nFileSizeHigh==0 && before.nFileSizeLow>0 && before.nFileSizeLow<=64*1024*1024,"STAGE_SIZE_UNSUPPORTED");
  std::vector<unsigned char> bytes(before.nFileSizeLow);
  DWORD offset=0;
  while(offset<bytes.size()) {
    DWORD read=0;
    require(ReadFile(input.value,bytes.data()+offset,static_cast<DWORD>(bytes.size()-offset),&read,nullptr)!=0 && read>0,"STAGE_READ_FAILED"); offset+=read;
  }
  unsigned char hash[32];
  require(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,bytes.data(),static_cast<ULONG>(bytes.size()),hash,sizeof(hash))>=0,"STAGE_HASH_FAILED");
  std::string digest; const char* hex="0123456789abcdef";
  for(auto c:hash) {digest+=hex[c>>4];digest+=hex[c&15];}
  require(GetFileInformationByHandle(input.value,&after)!=0 && sameInfo(before,after)
    && samePath(finalPath(input.value),expected),"STAGE_SOURCE_CHANGED");
  bool reused=std::wstring(digest.begin(),digest.end())==knownDigest;
  if(!reused) {
    // Never overwrite an existing file; incomplete files retain the .part name.
    File dest{CreateFileW(output.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr)};
    require(dest.value!=INVALID_HANDLE_VALUE,"STAGE_OUTPUT_FAILED");
    require(samePath(finalPath(dest.value),expectedOutput),"STAGE_OUTPUT_CHANGED");
    offset=0;
    while(offset<bytes.size()) {
      DWORD written=0;
      require(WriteFile(dest.value,bytes.data()+offset,static_cast<DWORD>(bytes.size()-offset),&written,nullptr)!=0 && written>0,"STAGE_WRITE_FAILED");offset+=written;
    }
    require(FlushFileBuffers(dest.value)!=0,"STAGE_FLUSH_FAILED");
  }
  std::cout<<"{\"type\":\"font-stage\",\"version\":1,\"ok\":true,\"digest\":\""<<digest<<"\",\"bytes\":"<<bytes.size()<<",\"reused\":"<<(reused?"true":"false")<<"}\n";
  return 0;
}
}
